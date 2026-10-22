import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { call, clean, freshAddress, pingBody } from './helpers';

const ID = '7b0d6c1e-2f4a-4c8e-9a51-3d2e1f0a9b77';

beforeEach(async () => {
  await clean();
  // No outbound verification in these tests: every hub is "offline".
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('not here', { status: 404 }));
});

async function firstContact(id = ID, address = freshAddress()) {
  const r = await call('/api/v1/ping', { json: pingBody(id), address, headers: { 'CF-IPCountry': 'GB' } });
  expect(r.status).toBe(200);
  expect(typeof r.body.token).toBe('string');
  return r.body.token as string;
}

describe('first contact', () => {
  it('issues a token once, and keeps only its hash', async () => {
    const token = await firstContact();
    const row = await env.DB.prepare('SELECT * FROM installs WHERE id = ?').bind(ID).first<any>();
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toContain(token);
    // Not from where the ping came from: a hub's ping leaves from a Cloudflare
    // data centre. The country comes from the cafe's listing at its check.
    expect(row.country).toBeNull();
    expect(row.level).toBe('standard');
    const pings = await env.DB.prepare('SELECT * FROM pings WHERE install_id = ?').bind(ID).all<any>();
    expect(pings.results).toHaveLength(1);
    expect(pings.results[0].repairs_fixed).toBe(27);
    expect(pings.results[0].co2_saved_kg).toBeCloseTo(451.25);
    expect(JSON.parse(pings.results[0].payload).installId).toBe(ID);
  });

  it('says the check is still running on the first ping', async () => {
    const r = await call('/api/v1/ping', { json: pingBody(ID), address: freshAddress() });
    expect(r.body.verification).toMatchObject({ verified: false, reason: null });
    expect(r.body.nextPingAfterHours).toBe(24);
  });

  it('refuses a token for an id nobody has claimed', async () => {
    const r = await call('/api/v1/ping', { json: pingBody(ID), token: 'made-up', address: freshAddress() });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('ping/unknown_install');
  });

  it('lets one address create only three installs an hour', async () => {
    const address = freshAddress();
    for (let i = 0; i < 3; i++) {
      const r = await call('/api/v1/ping', { json: pingBody(crypto.randomUUID()), address });
      expect(r.status).toBe(200);
    }
    const fourth = await call('/api/v1/ping', { json: pingBody(crypto.randomUUID()), address });
    expect(fourth.status).toBe(429);
    expect(fourth.body.code).toBe('ping/too_many_new');
    // Somebody else is not held up by it.
    const other = await call('/api/v1/ping', { json: pingBody(crypto.randomUUID()), address: freshAddress() });
    expect(other.status).toBe(200);
  });
});

describe('returning pings', () => {
  it('accepts the token, adds a ping, and issues no new token', async () => {
    const token = await firstContact();
    const r = await call('/api/v1/ping', {
      json: pingBody(ID, { repairsFixed: 30, app: { version: '1.3.0' } }),
      token,
      address: freshAddress(),
    });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeUndefined();
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM pings WHERE install_id = ?').bind(ID).first<any>();
    expect(n.n).toBe(2);
    const row = await env.DB.prepare('SELECT app_version FROM installs WHERE id = ?').bind(ID).first<any>();
    expect(row.app_version).toBe('1.3.0');
  });

  it('refuses a missing or wrong token', async () => {
    await firstContact();
    const none = await call('/api/v1/ping', { json: pingBody(ID), address: freshAddress() });
    expect(none.status).toBe(401);
    expect(none.body.code).toBe('ping/bad_token');
    const wrong = await call('/api/v1/ping', { json: pingBody(ID), token: 'nope', address: freshAddress() });
    expect(wrong.status).toBe(401);
  });

  it('answers a blocked install politely and drops what it sent', async () => {
    const token = await firstContact();
    await env.DB.prepare('UPDATE installs SET is_blocked = 1 WHERE id = ?').bind(ID).run();
    const r = await call('/api/v1/ping', { json: pingBody(ID), token, address: freshAddress() });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ ok: true, nextPingAfterHours: 168 });
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM pings').first<any>();
    expect(n.n).toBe(1);
  });

  it('clears what Community shared when an install drops to Standard', async () => {
    const address = freshAddress();
    const first = await call('/api/v1/ping', {
      json: pingBody(ID, { level: 'community', cafe: { name: 'Woodville', publicUrl: 'https://cafe.example.org', lat: 52.7712, lng: -1.5323 } }),
      address,
    });
    const row = await env.DB.prepare('SELECT * FROM installs WHERE id = ?').bind(ID).first<any>();
    expect(row.cafe_lat).toBe(52.77);
    expect(row.cafe_lng).toBe(-1.53);
    await call('/api/v1/ping', { json: pingBody(ID), token: first.body.token, address });
    const after = await env.DB.prepare('SELECT * FROM installs WHERE id = ?').bind(ID).first<any>();
    expect(after).toMatchObject({ cafe_name: null, cafe_url: null, cafe_lat: null, cafe_lng: null, level: 'standard' });
  });

  it('allows thirty pings an hour from one address and no more', async () => {
    const address = freshAddress();
    const token = await firstContact(ID, address);
    for (let i = 1; i < 30; i++) {
      const r = await call('/api/v1/ping', { json: pingBody(ID), token, address });
      expect(r.status).toBe(200);
    }
    const r = await call('/api/v1/ping', { json: pingBody(ID), token, address });
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe('3600');
  });
});

describe('what we refuse to read', () => {
  it('rejects a body that does not match the schema', async () => {
    const r = await call('/api/v1/ping', { json: pingBody(ID, { level: 'everything' }), address: freshAddress() });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('ping/invalid');
  });

  it('drops anything the schema does not describe before storing the body', async () => {
    await call('/api/v1/ping', { json: { ...pingBody(ID), freeText: 'a name and a phone number' }, address: freshAddress() });
    const p = await env.DB.prepare('SELECT payload FROM pings').first<any>();
    expect(p.payload).not.toContain('phone');
  });

  it('rejects something that is not JSON', async () => {
    const r = await call('/api/v1/ping', { body: '{not json', address: freshAddress(), headers: { 'Content-Type': 'application/json' } });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('body/invalid_json');
  });

  it('rejects a body over 64 KB without reading it all', async () => {
    const r = await call('/api/v1/ping', { body: 'x'.repeat(70 * 1024), address: freshAddress() });
    expect(r.status).toBe(413);
  });

  it('rejects a clock more than two days out', async () => {
    const sentAt = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const r = await call('/api/v1/ping', { json: pingBody(ID, { sentAt }), address: freshAddress() });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('ping/clock_skew');
  });

  it('keeps standard-level cafe details off the record', async () => {
    await call('/api/v1/ping', {
      json: pingBody(ID, { cafe: { name: 'Should not be kept', lat: 50, lng: 0 } }),
      address: freshAddress(),
    });
    const row = await env.DB.prepare('SELECT cafe_name, cafe_lat FROM installs WHERE id = ?').bind(ID).first<any>();
    expect(row).toEqual({ cafe_name: null, cafe_lat: null });
  });
});

describe('forget', () => {
  it('deletes the install and, through the foreign key, its pings', async () => {
    const token = await firstContact();
    const r = await call('/api/v1/forget', { json: { installId: ID }, token, address: freshAddress() });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, forgotten: true });
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM pings').first<any>();
    expect(n.n).toBe(0);
  });

  it('gives the same answer for a wrong token as for an unknown id', async () => {
    await firstContact();
    const wrong = await call('/api/v1/forget', { json: { installId: ID }, token: 'nope', address: freshAddress() });
    const unknown = await call('/api/v1/forget', { json: { installId: crypto.randomUUID() }, token: 'nope', address: freshAddress() });
    expect(wrong.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('needs both an id and a token', async () => {
    const r = await call('/api/v1/forget', { json: {}, address: freshAddress() });
    expect(r.status).toBe(400);
  });
});
