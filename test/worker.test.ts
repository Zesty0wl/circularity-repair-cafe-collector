import { createExecutionContext, createScheduledController, env, evictDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { limitFor } from '../src/limiter';
import worker from '../src/worker';
import { BASE, call, clean, freshAddress } from './helpers';

beforeEach(async () => {
  await clean();
  vi.restoreAllMocks();
});

describe('the Worker', () => {
  it('answers /health', async () => {
    const r = await call('/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('answers HEAD wherever it answers GET, with no body', async () => {
    const r = await call('/health', { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(await r.raw.text()).toBe('');
  });

  it('answers an unknown API path with a 404 in JSON', async () => {
    const r = await call('/api/v1/nothing');
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('not_found');
  });

  // SELF calls the Worker itself, so the page is asked of the assets binding,
  // which is what Cloudflare answers from before the Worker runs.
  it('serves the page with its version stamped and its security headers', async () => {
    const r = await env.ASSETS.fetch(`${BASE}/`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('What repair cafés achieve together');
    expect(html).not.toContain('__V__');
    expect(html).toMatch(/maplibre-gl\.mjs\?v=[0-9a-f]{12}/);
    expect(r.headers.get('Content-Security-Policy')).toContain('connect-src \'self\' https://tiles.openfreemap.org');
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('serves MapLibre as JavaScript, and not its source maps', async () => {
    const js = await env.ASSETS.fetch(`${BASE}/vendor/maplibre/maplibre-gl.mjs`);
    expect(js.status).toBe(200);
    expect(js.headers.get('Content-Type')).toMatch(/javascript/);
    await js.body?.cancel();
    const map = await env.ASSETS.fetch(`${BASE}/vendor/maplibre/maplibre-gl.mjs.map`);
    expect(map.status).toBe(404);
    await map.body?.cancel();
  });
});

describe('the hourly limiter', () => {
  it('keeps counting after it is evicted from memory', async () => {
    const address = freshAddress();
    let limiter = await limitFor(env, address);
    for (let i = 0; i < 3; i++) expect(await limiter.take('new-install', 3)).toBe(true);
    await evictDurableObject(limiter);
    limiter = await limitFor(env, address);
    expect(await limiter.take('new-install', 3)).toBe(false);
    // A different kind of request from the same address has its own count.
    expect(await limiter.take('forget', 10)).toBe(true);
  });

  it('is named by a keyed hash, never by the address', async () => {
    const address = '192.0.2.44';
    const limiter = await limitFor(env, address);
    expect(limiter.id.toString()).not.toContain(address);
    expect(limiter.id.equals(env.LIMITER.idFromName(address))).toBe(false);
  });
});

/** Run the daily cron the way Cloudflare would, and wait for it to finish. */
async function runCron() {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: '17 4 * * *', scheduledTime: Date.now() }), env, ctx);
  await waitOnExecutionContext(ctx);
}

describe('the directory', () => {
  const upstream = [
    { link: 'https://www.repaircafe.org/en/cafe/repair-cafe-woodville/', coordinate: '52.77123,-1.53211', name: 'Repair Caf&eacute; Woodville', address: 'High St, Woodville, United Kingdom', external_link: 'https://woodville.example.org' },
    { link: 'https://www.repaircafe.org/en/cafe/nowhere/', coordinate: '0,0', name: 'In the Atlantic', address: '', external_link: null },
  ];

  it('is refreshed by the daily cron', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(upstream));
    await runCron();
    const rows = await env.DB.prepare('SELECT * FROM directory').all<any>();
    expect(rows.results).toEqual([
      { slug: 'repair-cafe-woodville', name: 'Repair Café Woodville', lat: 52.77123, lng: -1.53211, country: 'United Kingdom', website: 'https://woodville.example.org' },
    ]);
  });

  it('skips a badly encoded link instead of failing the whole refresh', async () => {
    const broken = { link: 'https://www.repaircafe.org/en/cafe/bad%E0%A4%A/', coordinate: '1,1', name: 'Broken', address: '', external_link: null };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json([broken, ...upstream]));
    await runCron();
    const rows = await env.DB.prepare('SELECT slug FROM directory').all<any>();
    expect(rows.results.map((r: any) => r.slug)).toEqual(['repair-cafe-woodville']);
  });

  it('keeps the old copy when repaircafe.org answers with nothing', async () => {
    await env.DB.prepare("INSERT INTO directory VALUES ('kept', 'Kept', 1, 1, null, null)").run();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json([]));
    await runCron();
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM directory').first<any>();
    expect(n.n).toBe(1);
  });

  it('copes with thousands of cafés in one go', async () => {
    const many = Array.from({ length: 3000 }, (_, i) => ({
      link: `https://www.repaircafe.org/en/cafe/cafe-${i}/`, coordinate: `${(i % 80) + 1},${(i % 170) + 1}`, name: `Café ${i}`, address: 'Somewhere', external_link: null,
    }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(many));
    await runCron();
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM directory').first<any>();
    expect(n.n).toBe(3000);
  });
});
