import { env, SELF } from 'cloudflare:test';

export const BASE = 'https://repaircafetelemetry.test';
export const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';

let lastAddress = 0;
/**
 * A different made-up address for each caller, so one test's rate limits
 * never spill into the next.
 */
export function freshAddress(): string {
  lastAddress += 1;
  return `198.51.${Math.floor(lastAddress / 250)}.${lastAddress % 250}`;
}

export interface CallOptions {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  token?: string | null;
  address?: string;
  headers?: Record<string, string>;
}

export async function call<T = any>(path: string, opts: CallOptions = {}) {
  const headers: Record<string, string> = {
    'CF-Connecting-IP': opts.address ?? '203.0.113.1',
    ...(opts.headers ?? {}),
  };
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const raw = await SELF.fetch(`${BASE}${path}`, {
    method: opts.method ?? (body !== undefined ? 'POST' : 'GET'),
    headers,
    body,
  });
  const type = raw.headers.get('content-type') ?? '';
  const parsed = type.includes('json') ? ((await raw.clone().json().catch(() => null)) as T) : (null as T);
  return { status: raw.status, body: parsed, headers: raw.headers, raw };
}

/** Empty every table, so each test starts from nothing. */
export async function clean(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM pings'),
    env.DB.prepare('DELETE FROM installs'),
    env.DB.prepare('DELETE FROM directory'),
  ]);
}

/** A ping body as a real hub sends it. */
export function pingBody(installId: string, over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    level: 'standard',
    installId,
    sentAt: new Date().toISOString(),
    app: { version: '1.2.3' },
    howManySessions: 5,
    howManyVolunteers: 3,
    repairsRecorded: 40,
    repairsFixed: 27,
    repairsNotFixed: 8,
    co2: { savedKg: 451.25 },
    ...over,
  };
}

/** A community ping that asks to be on the map. */
export function communityBody(installId: string, cafe: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return pingBody(installId, { level: 'community', cafe, ...over });
}

/** Wait for background work (ctx.waitUntil) to land in the database. */
export async function eventually<T>(check: () => Promise<T | null | undefined | false>, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** An answer a hub's /api/public/telemetry might give. */
export function hubAnswer(installId: string, over: Record<string, unknown> = {}) {
  return Response.json({
    installId,
    name: 'Repair Café Woodville',
    repairsRecorded: 40,
    repairsFixed: 27,
    repairsNotFixed: 8,
    sessionsHeld: 5,
    volunteers: 3,
    co2SavedKg: 451.2,
    ...over,
  });
}
