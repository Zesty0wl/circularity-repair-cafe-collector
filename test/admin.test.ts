import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_TOKEN, call, clean, freshAddress, pingBody } from './helpers';

const ID = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';

beforeEach(async () => {
  await clean();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 404 }));
});

describe('admin', () => {
  it('turns away a missing or wrong token, including a multi-byte one', async () => {
    for (const token of [null, 'wrong', 'ünïcödé-tøken']) {
      const r = await call('/api/v1/admin/installs', { token, address: freshAddress() });
      expect(r.status).toBe(401);
    }
  });

  it('lists installs with their newest ping and readable dates', async () => {
    const first = await call('/api/v1/ping', { json: pingBody(ID, { repairsFixed: 10 }), address: freshAddress() });
    await call('/api/v1/ping', { json: pingBody(ID, { repairsFixed: 12 }), token: first.body.token, address: freshAddress() });
    const r = await call('/api/v1/admin/installs', { token: ADMIN_TOKEN, address: freshAddress() });
    expect(r.status).toBe(200);
    expect(r.body.installs).toHaveLength(1);
    expect(r.body.installs[0]).toMatchObject({ id: ID, repairs_fixed: 12, ping_count: 2, is_blocked: false });
    expect(r.body.installs[0].last_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('gives an overview, with weeks starting on Monday', async () => {
    // Wednesday 15 October 2026.
    const wed = Date.UTC(2026, 9, 15, 12);
    await env.DB.prepare(
      "INSERT INTO installs (id, token_hash, created_at, last_seen_at, app_version, level) VALUES (?, 'x', ?, ?, '1.0', 'community')",
    ).bind(ID, wed, Date.now()).run();
    const r = await call('/api/v1/admin/overview', { token: ADMIN_TOKEN, address: freshAddress() });
    expect(r.body.activity).toMatchObject({ total: 1, seen_2d: 1, seen_45d: 1, on_the_map: 1, blocked: 0 });
    expect(r.body.versions).toEqual([{ version: '1.0', installs: 1 }]);
    expect(r.body.newPerWeek).toEqual([{ week: '2026-10-12', installs: 1 }]);
  });

  it('blocks and unblocks, and says when there is nothing to block', async () => {
    await call('/api/v1/ping', { json: pingBody(ID), address: freshAddress() });
    const on = await call(`/api/v1/admin/installs/${ID}/block`, { method: 'POST', token: ADMIN_TOKEN, address: freshAddress() });
    expect(on.body).toEqual({ ok: true, id: ID, blocked: true });
    const off = await call(`/api/v1/admin/installs/${ID}/block`, { json: { blocked: false }, token: ADMIN_TOKEN, address: freshAddress() });
    expect(off.body.blocked).toBe(false);
    const missing = await call('/api/v1/admin/installs/not-a-uuid/block', { method: 'POST', token: ADMIN_TOKEN, address: freshAddress() });
    expect(missing.status).toBe(404);
  });

  it('allows thirty admin requests a minute from one address', async () => {
    const address = freshAddress();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await call('/api/v1/admin/overview', { token: ADMIN_TOKEN, address })).status;
    expect(last).toBe(429);
  });
});
