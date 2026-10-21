import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { database } from '../src/db/index';
import { verifiableUrl, verifyIfDue, verifyInstall } from '../src/services/verify';
import { call, clean, communityBody, eventually, freshAddress, hubAnswer } from './helpers';

const ID = '1f6c0b2a-8d3e-4f5a-b6c7-d8e9f0a1b2c3';
const fetchSpy = () => vi.spyOn(globalThis, 'fetch');

beforeEach(async () => {
  await clean();
  vi.restoreAllMocks();
});

describe('which addresses we will fetch', () => {
  it.each([
    ['http://cafe.example.org', 'plain http proves nothing'],
    ['https://203.0.113.9', 'a bare IPv4 address'],
    ['https://[2001:db8::1]', 'a bare IPv6 address'],
    ['https://localhost', 'a name with no dot'],
    ['not a url', 'nonsense'],
  ])('refuses %s (%s)', (url) => {
    expect(verifiableUrl(url)).toBeNull();
  });

  it('keeps only the host, and always asks the same path', () => {
    expect(verifiableUrl('https://cafe.example.org/some/path?x=1#y')?.toString()).toBe(
      'https://cafe.example.org/api/public/telemetry',
    );
  });
});

describe('a check', () => {
  it('trusts the figures the site served, not the ones it was sent', async () => {
    const spy = fetchSpy().mockImplementation(async () => hubAnswer(ID));
    const out = await verifyInstall(ID, 'https://cafe.example.org');
    expect(out).toMatchObject({ ok: true, host: 'cafe.example.org', name: 'Repair Café Woodville' });
    expect(out.figures?.repairsFixed).toBe(27);
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe('https://cafe.example.org/api/public/telemetry');
    expect((init as RequestInit).redirect).toBe('manual');
  });

  it('does not follow a redirect', async () => {
    fetchSpy().mockImplementation(async () => new Response(null, { status: 302, headers: { Location: 'http://10.0.0.1/' } }));
    const out = await verifyInstall(ID, 'https://cafe.example.org');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/redirect/);
  });

  it('stops reading after 64 KB', async () => {
    fetchSpy().mockImplementation(async () => new Response('x'.repeat(65 * 1024)));
    const out = await verifyInstall(ID, 'https://cafe.example.org');
    expect(out).toMatchObject({ ok: false, error: 'the hub sent more than we will read' });
  });

  it('refuses a site that names a different install', async () => {
    fetchSpy().mockImplementation(async () => hubAnswer(crypto.randomUUID()));
    const out = await verifyInstall(ID, 'https://cafe.example.org');
    expect(out).toMatchObject({ ok: false, error: 'that site belongs to a different install' });
  });

  it('says plainly when a hub is not sharing', async () => {
    fetchSpy().mockImplementation(async () => new Response('', { status: 404 }));
    const out = await verifyInstall(ID, 'https://cafe.example.org');
    expect(out.error).toBe('that hub is not sharing its numbers');
  });
});

describe('after a ping', () => {
  it('verifies in the background and publishes the fetched figures and name', async () => {
    fetchSpy().mockImplementation(async () => hubAnswer(ID, { repairsFixed: 99 }));
    await call('/api/v1/ping', {
      json: communityBody(ID, { name: 'Whatever they typed', publicUrl: 'https://cafe.example.org', lat: 52.77, lng: -1.53 }),
      address: freshAddress(),
    });
    const row = await eventually(() =>
      env.DB.prepare('SELECT * FROM installs WHERE id = ? AND verified_at IS NOT NULL').bind(ID).first<any>(),
    );
    expect(row).toMatchObject({
      verified_host: 'cafe.example.org',
      verified_repairs_fixed: 99,
      cafe_name: 'Repair Café Woodville',
      verify_error: null,
    });
  });

  it('records why a check failed, and waits before looking again', async () => {
    const spy = fetchSpy().mockImplementation(async () => new Response('', { status: 500 }));
    const db = database(env.DB);
    await env.DB.prepare(
      "INSERT INTO installs (id, token_hash, created_at, last_seen_at) VALUES (?, 'x', ?, ?)",
    ).bind(ID, Date.now(), Date.now()).run();
    await verifyIfDue(db, env, ID, 'https://cafe.example.org');
    await verifyIfDue(db, env, ID, 'https://cafe.example.org');
    expect(spy).toHaveBeenCalledTimes(1);
    const row = await env.DB.prepare('SELECT * FROM installs WHERE id = ?').bind(ID).first<any>();
    expect(row.verify_error).toBe('the hub answered 500');
    expect(row.verified_at).toBeNull();
    expect(row.verify_checked_at).toBeGreaterThan(0);
  });
});
