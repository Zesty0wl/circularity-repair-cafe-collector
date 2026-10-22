import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { call, clean } from './helpers';

const DAY = 24 * 60 * 60 * 1000;

interface Seed {
  id?: string;
  level?: string;
  verified?: boolean;
  blocked?: boolean;
  lastSeenDaysAgo?: number;
  country?: string | null;
  name?: string | null;
  slug?: string | null;
  host?: string | null;
  lat?: number | null;
  lng?: number | null;
  fixed?: number;
  notFixed?: number;
  co2?: number;
  /** The name the site served at its check. Defaults to `name`. */
  verifiedName?: string;
}

async function seed(s: Seed) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO installs (id, token_hash, created_at, last_seen_at, level, country, cafe_name, cafe_slug, cafe_lat, cafe_lng,
       is_blocked, verified_at, verified_host, verified_repairs_recorded, verified_repairs_fixed, verified_repairs_not_fixed,
       verified_sessions_held, verified_volunteers, verified_co2_saved_kg, verified_name)
     VALUES (?, 'x', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      s.id ?? crypto.randomUUID(), now, now - (s.lastSeenDaysAgo ?? 0) * DAY, s.level ?? 'community', s.country ?? 'GB',
      s.name ?? 'A café', s.slug ?? null, s.lat ?? null, s.lng ?? null, s.blocked ? 1 : 0,
      s.verified === false ? null : now, s.host ?? 'cafe.example.org',
      (s.fixed ?? 10) + (s.notFixed ?? 5), s.fixed ?? 10, s.notFixed ?? 5, 4, 2, s.co2 ?? 100.04,
      s.verified === false ? null : (s.verifiedName ?? s.name ?? 'A café'),
    )
    .run();
}

// Both answers are cached for five minutes, and the query string is ignored,
// so each test starts with an empty cache.
const fresh = (path: string) => path;

beforeEach(async () => {
  await clean();
  for (const path of ['/api/v1/public/summary', '/api/v1/public/map']) {
    await caches.default.delete(new Request(`https://repaircafetelemetry.test${path}`));
  }
});

describe('summary', () => {
  it('counts only verified, active, unblocked installs, and says how many it could not check', async () => {
    await seed({ fixed: 27, notFixed: 8, co2: 451.25 });
    await seed({ fixed: 3, notFixed: 1, co2: 10, country: 'NL' });
    await seed({ verified: false, fixed: 1000 });
    await seed({ blocked: true, fixed: 1000 });
    await seed({ lastSeenDaysAgo: 46, fixed: 1000 });
    const r = await call(fresh('/api/v1/public/summary'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      installs: 2,
      countries: 2,
      repairsFixed: 30,
      repairsRecorded: 39,
      sessionsHeld: 8,
      volunteers: 4,
      successRate: 77,
      co2SavedKg: 461.3,
      reportedInstalls: 1,
      activeWithinDays: 45,
    });
    expect(r.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('answers from the cache for five minutes', async () => {
    const url = fresh('/api/v1/public/summary');
    await seed({ fixed: 27 });
    const first = await call(url);
    await seed({ fixed: 1000 });
    const second = await call(url);
    expect(second.body.repairsFixed).toBe(first.body.repairsFixed);
  });

  it('says nothing has been shared rather than failing on an empty table', async () => {
    const r = await call(fresh('/api/v1/public/summary'));
    expect(r.body).toMatchObject({ installs: 0, repairsFixed: 0, successRate: 0, co2SavedKg: 0 });
  });
});

describe('map', () => {
  it('shows only what was checked: the served name, the verified host, and a pin from the listing', async () => {
    await env.DB.prepare("INSERT INTO directory VALUES ('woodville', 'Woodville', 52.77, -1.53, 'UK', 'https://woodville.example.org')").run();
    // The name and coordinates a ping sent are ignored.
    await seed({ name: 'Typed in a ping', verifiedName: 'Woodville', slug: 'woodville', lat: 10, lng: 10, host: 'woodville.example.org' });
    await seed({ name: 'Standard level', level: 'standard', slug: 'woodville' });
    await seed({ name: 'Unverified', verified: false, slug: 'woodville' });
    const r = await call(fresh('/api/v1/public/map'));
    expect(r.body.cafes).toHaveLength(1);
    expect(r.body.cafes[0]).toMatchObject({
      name: 'Woodville',
      url: 'https://woodville.example.org/',
      lat: 52.77,
      lng: -1.53,
      host: 'woodville.example.org',
      placedBy: 'its repaircafe.org listing',
      verified: true,
    });
  });

  it('ignores the query string, so it cannot be used to skip the cache', async () => {
    await call('/api/v1/public/summary');
    await seed({ fixed: 1000 });
    expect((await call('/api/v1/public/summary?skip=1')).body.repairsFixed).toBe(0);
  });

  it('places a café from its repaircafe.org listing, but never from a listing that names another site', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO directory VALUES ('ours', 'Ours', 51.5, -0.12, 'UK', 'https://ours.example.org/')"),
      env.DB.prepare("INSERT INTO directory VALUES ('theirs', 'Theirs', 48.85, 2.35, 'France', 'https://theirs.example.org')"),
    ]);
    await seed({ name: 'Ours', slug: 'ours', host: 'ours.example.org' });
    // Proved it owns its own domain, then claimed somebody else's listing.
    await seed({ name: 'Borrower', slug: 'theirs', host: 'borrower.example.org' });
    const r = await call(fresh('/api/v1/public/map'));
    expect(r.body.cafes).toHaveLength(1);
    expect(r.body.cafes[0]).toMatchObject({ name: 'Ours', lat: 51.5, lng: -0.12, placedBy: 'its repaircafe.org listing' });
  });

  it('also places a café whose listing names no website, or the same site with "www."', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO directory VALUES ('no-site', 'No site', 43.66, 7.12, 'France', NULL)"),
      env.DB.prepare("INSERT INTO directory VALUES ('www-site', 'Www site', 52.0, 4.3, 'Nederland', 'www.wwwsite.example.org')"),
      env.DB.prepare("INSERT INTO directory VALUES ('bad-site', 'Bad site', 50.0, 3.0, 'Belgique', 'see our facebook page')"),
    ]);
    await seed({ name: 'No site', slug: 'no-site', host: 'hub.example.workers.dev' });
    await seed({ name: 'Www site', slug: 'www-site', host: 'wwwsite.example.org' });
    // A website we cannot read is refused, not guessed at.
    await seed({ name: 'Bad site', slug: 'bad-site', host: 'bad.example.org' });
    const r = await call(fresh('/api/v1/public/map'));
    expect(r.body.cafes.map((c: any) => c.name)).toEqual(['No site', 'Www site']);
  });
});
