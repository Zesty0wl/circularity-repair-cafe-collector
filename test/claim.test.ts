// A hub's install id is public: its own site shows it, because that is how we
// check the hub is real. So the id alone must not decide who owns an install.
// Hubs from 1.13.2 make a claim secret, send it with their pings, and publish
// only its hash. See the claim rules in src/routes/ping.ts and the check in
// src/services/verify.ts.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/lib/tokens';
import { reasonForSender, verifyInstall } from '../src/services/verify';
import { call, clean, communityBody, eventually, freshAddress, hubAnswer } from './helpers';

const ID = '5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const SECRET = 'real-hub-claim-secret-0123456789abcdefABCDEF';
const SITE = { name: 'Repair Café Woodville', publicUrl: 'https://cafe.example.org' };

beforeEach(async () => {
  await clean();
  vi.restoreAllMocks();
  // The real hub's site, which publishes the hash of its secret.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => hubAnswer(ID, { claimHash: hashToken(SECRET) }));
});

const row = () => env.DB.prepare('SELECT * FROM installs WHERE id = ?').bind(ID).first<any>();

describe('claiming an install id', () => {
  it('never verifies a stranger who claimed the id first, and gives it back to the real hub', async () => {
    // A stranger copies the id from the hub's site and pings first.
    const stranger = await call('/api/v1/ping', { json: communityBody(ID, SITE), address: freshAddress() });
    expect(stranger.status).toBe(200);
    const strangerToken = stranger.body.token as string;
    const failed = await eventually(async () => {
      const r = await row();
      return r?.verify_checked_at ? r : null;
    });
    expect(failed.verified_at).toBeNull();
    expect(failed.verify_error).toBe('that site belongs to a different install');

    // The real hub has no token, but has its secret.
    const real = await call('/api/v1/ping', { json: communityBody(ID, SITE, { claim: SECRET }), address: freshAddress() });
    expect(real.status).toBe(200);
    expect(typeof real.body.token).toBe('string');
    const verified = await eventually(async () => {
      const r = await row();
      return r?.verified_at ? r : null;
    });
    expect(verified.claim_hash).toBe(hashToken(SECRET));

    // The stranger's token no longer works.
    const again = await call('/api/v1/ping', { json: communityBody(ID, SITE), token: strangerToken, address: freshAddress() });
    expect(again.status).toBe(401);
  });

  it('will not hand a verified install to anybody without its secret', async () => {
    const first = await call('/api/v1/ping', { json: communityBody(ID, SITE, { claim: SECRET }), address: freshAddress() });
    expect(first.status).toBe(200);
    await eventually(async () => (await row())?.verified_at);

    const thief = await call('/api/v1/ping', {
      json: communityBody(ID, SITE, { claim: 'a-different-secret-0123456789abcdefABCDEF' }),
      address: freshAddress(),
    });
    expect(thief.status).toBe(401);
  });

  it('lets the real hub back in with its secret after losing its token, and keeps it verified', async () => {
    await call('/api/v1/ping', { json: communityBody(ID, SITE, { claim: SECRET }), address: freshAddress() });
    await eventually(async () => (await row())?.verified_at);

    const back = await call('/api/v1/ping', { json: communityBody(ID, SITE, { claim: SECRET }), address: freshAddress() });
    expect(back.status).toBe(200);
    expect(typeof back.body.token).toBe('string');
    expect((await row()).verified_at).not.toBeNull();
  });
});

describe('what a check accepts and says', () => {
  it('fails a site that serves an impossible figure', async () => {
    for (const over of [{ repairsFixed: 1e300 }, { repairsFixed: 2.5 }, { volunteers: -1 }, { co2SavedKg: 5e9 }]) {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => hubAnswer(ID, over));
      const out = await verifyInstall(ID, 'https://cafe.example.org');
      expect(out, JSON.stringify(over)).toMatchObject({ ok: false, error: 'the hub served figures we cannot use' });
    }
  });

  it('tells the sender only the kind of problem, never what another server answered', () => {
    expect(reasonForSender('the hub answered 503')).toBe('we could not read /api/public/telemetry at that address');
    expect(reasonForSender('the hub redirected (302), and we do not follow redirects')).toBe(
      'we could not read /api/public/telemetry at that address',
    );
    expect(reasonForSender('connect ECONNREFUSED 10.0.0.1:8443')).toBe('we could not read /api/public/telemetry at that address');
    expect(reasonForSender('that site belongs to a different install')).toBe('that site belongs to a different install');
    expect(reasonForSender(null)).toBeNull();
  });
});
