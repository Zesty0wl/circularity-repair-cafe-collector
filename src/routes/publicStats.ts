import { sql } from 'drizzle-orm';
import { database } from '../db/index.js';
import type { Env } from '../env.js';
import { json } from '../lib/http.js';
import { haveDirectory, lookupSlug, refreshDirectory } from '../services/directory.js';

/**
 * What the community has done, in public
 * ──────────────────────────────────────
 * THE ONE THING TO GET RIGHT: every number a hub sends is a running total for
 * the life of that install, not a figure for the day. So a worldwide total is
 * never a sum over the pings table, which multiplies every cafe by the number
 * of days it has been running and looks entirely plausible while being wrong
 * by a factor of hundreds.
 *
 * What is published is the figures we fetched from each cafe's own site, one
 * row per install in `installs`, so there is nothing to de-duplicate.
 */

/** An install we have not heard from in this long is not counted as active. */
const ACTIVE_DAYS = 45;

/** The same answer for everyone, and it moves slowly. */
const CACHE_SECONDS = 300;

/** When this isolate last tried to fill an empty directory. */
const DIRECTORY_RETRY_MS = 10 * 60 * 1000;
let lastDirectoryAttempt = 0;

function activeSince(): number {
  return Date.now() - ACTIVE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Answer from Cloudflare's cache when we can. The cache only exists on a real
 * domain; on workers.dev this quietly computes every time.
 */
async function cached(request: Request, ctx: ExecutionContext, build: () => Promise<unknown>): Promise<Response> {
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;
  const response = json(await build(), 200, { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

export async function summary(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return cached(request, ctx, async () => {
    const db = database(env.DB);
    const since = activeSince();

    // Verified installs only. The figures published here are the ones we
    // fetched from each cafe's own site, not the ones we were handed: those
    // are kept in `pings` as history, but anybody can post a number and only a
    // fetched one can be checked. See services/verify.ts.
    const [t] = await db.all<Record<string, number | null>>(sql`
      SELECT
        COUNT(*)                                       AS installs,
        COALESCE(SUM(verified_sessions_held), 0)       AS sessions_held,
        COALESCE(SUM(verified_volunteers), 0)          AS volunteers,
        COALESCE(SUM(verified_repairs_recorded), 0)    AS repairs_recorded,
        COALESCE(SUM(verified_repairs_fixed), 0)       AS repairs_fixed,
        COALESCE(SUM(verified_repairs_not_fixed), 0)   AS repairs_not_fixed,
        COALESCE(SUM(verified_co2_saved_kg), 0)        AS co2_saved_kg,
        COUNT(DISTINCT country)                        AS countries
      FROM installs
      WHERE is_blocked = 0
        AND verified_at IS NOT NULL
        AND last_seen_at > ${since}
    `);

    // Installs we have heard from but could not check: counted, never
    // published as impact. Shown so the gap is visible rather than hidden.
    const [reported] = await db.all<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM installs
      WHERE is_blocked = 0
        AND verified_at IS NULL
        AND last_seen_at > ${since}
    `);

    const fixed = Number(t?.repairs_fixed ?? 0);
    const closed = fixed + Number(t?.repairs_not_fixed ?? 0);

    return {
      installs: Number(t?.installs ?? 0),
      countries: Number(t?.countries ?? 0),
      sessionsHeld: Number(t?.sessions_held ?? 0),
      volunteers: Number(t?.volunteers ?? 0),
      repairsRecorded: Number(t?.repairs_recorded ?? 0),
      repairsFixed: fixed,
      successRate: closed > 0 ? Math.round((fixed / closed) * 100) : 0,
      co2SavedKg: Math.round(Number(t?.co2_saved_kg ?? 0) * 10) / 10,
      // Said out loud, because it is the honest caveat: cafes that chose not
      // to share are invisible here, so every figure is a floor.
      reportedInstalls: Number(reported?.n ?? 0),
      note:
        'Counts only the cafés that chose to share their numbers and whose own site we could check, so these are a minimum.',
      activeWithinDays: ACTIVE_DAYS,
      generatedAt: new Date().toISOString(),
    };
  });
}

/**
 * The pins for the map. Only installs that chose the Community level appear,
 * and only the ones that gave us somewhere to put a pin.
 */
export async function map(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return cached(request, ctx, async () => {
    const db = database(env.DB);
    // Verified installs only, and the name is the one that site served us
    // rather than one anybody could type. A slug is not proof of anything and
    // is no longer resolved: see docs/proposal-verified-telemetry.md.
    const rows = await db.all<Record<string, unknown>>(sql`
      SELECT
        cafe_name, cafe_url, cafe_slug, verified_host, country,
        cafe_lat, cafe_lng,
        verified_repairs_fixed, verified_sessions_held, verified_co2_saved_kg
      FROM installs
      WHERE level = 'community'
        AND is_blocked = 0
        AND verified_at IS NOT NULL
        AND last_seen_at > ${activeSince()}
      ORDER BY cafe_name
    `);

    // The cron fills the directory daily. Until it first has, a map request
    // waits for the fill rather than caching a map with pins missing. If
    // repaircafe.org is down, only one request in ten minutes waits to find out.
    if (rows.some((r) => r.cafe_lat === null && r.cafe_slug) && !(await haveDirectory(db))) {
      if (Date.now() - lastDirectoryAttempt > DIRECTORY_RETRY_MS) {
        lastDirectoryAttempt = Date.now();
        await refreshDirectory(db).catch(() => 0);
      }
    }

    // Where the pin comes from.
    //
    // Own coordinates win. Otherwise the repaircafe.org listing may supply
    // them, but ONLY when the website that listing names is the same host we
    // just verified. Without that check a cafe could prove it controls its own
    // domain and then claim somebody else's slug to borrow their address. The
    // directory is a convenience here, never a credential: `external_link` is
    // free text a cafe typed in years ago.
    const cafes = await Promise.all(
      rows.map(async (r: any) => {
        let lat = r.cafe_lat === null ? null : Number(r.cafe_lat);
        let lng = r.cafe_lng === null ? null : Number(r.cafe_lng);
        let placedBy: 'itself' | 'its repaircafe.org listing' | null = lat === null ? null : 'itself';
        if (lat === null && r.cafe_slug && r.verified_host) {
          const listed = await lookupSlug(db, r.cafe_slug);
          let listedHost: string | null = null;
          try {
            listedHost = listed?.website ? new URL(listed.website).hostname.toLowerCase() : null;
          } catch {
            listedHost = null;
          }
          if (listedHost && listedHost === String(r.verified_host).toLowerCase()) {
            lat = listed!.lat;
            lng = listed!.lng;
            placedBy = 'its repaircafe.org listing';
          }
        }
        return {
          name: r.cafe_name,
          url: r.cafe_url,
          host: r.verified_host,
          lat,
          lng,
          placedBy,
          country: r.country,
          repairsFixed: Number(r.verified_repairs_fixed ?? 0),
          sessionsHeld: Number(r.verified_sessions_held ?? 0),
          co2SavedKg: Math.round(Number(r.verified_co2_saved_kg ?? 0) * 10) / 10,
          verified: true,
        };
      })
    );
    return {
      cafes: cafes.filter((c) => c.lat !== null && c.lng !== null),
      generatedAt: new Date().toISOString(),
    };
  });
}
