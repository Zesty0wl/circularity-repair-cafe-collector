import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { lookupSlug } from '../services/directory.js';

/**
 * What the community has done, in public
 * ──────────────────────────────────────
 * THE ONE THING TO GET RIGHT: every number a hub sends is a running total for
 * the life of that install, not a figure for the day. So a worldwide total is
 * a sum over the NEWEST ping per install. Summing the whole pings table
 * multiplies every cafe by the number of days it has been running, and the
 * answer looks entirely plausible while being wrong by a factor of hundreds.
 *
 * `DISTINCT ON (install_id) ... ORDER BY install_id, received_at DESC` is
 * Postgres's way of saying "the newest row per install", and the
 * (install_id, received_at DESC) index makes it cheap.
 */

/** An install we have not heard from in this long is not counted as active. */
const ACTIVE_DAYS = 45;

/** Cached in memory: this is the same answer for everyone, and it moves slowly. */
const CACHE_MS = 5 * 60 * 1000;
let cached: { at: number; body: unknown } | null = null;

export async function publicStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/public/summary', async (_request, reply) => {
    void reply.header('Cache-Control', 'public, max-age=300');
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.body;

    // Verified installs only. The figures published here are the ones we
    // fetched from each cafe's own site, not the ones we were handed: those
    // are kept in `pings` as history, but anybody can post a number and only a
    // fetched one can be checked. See services/verify.ts.
    const totals = await db.execute(sql`
      SELECT
        COUNT(*)::int                                        AS installs,
        COALESCE(SUM(verified_sessions_held), 0)::int        AS sessions_held,
        COALESCE(SUM(verified_volunteers), 0)::int           AS volunteers,
        COALESCE(SUM(verified_repairs_recorded), 0)::int     AS repairs_recorded,
        COALESCE(SUM(verified_repairs_fixed), 0)::int        AS repairs_fixed,
        COALESCE(SUM(verified_repairs_not_fixed), 0)::int    AS repairs_not_fixed,
        COALESCE(SUM(verified_co2_saved_kg), 0)::float       AS co2_saved_kg
      FROM installs
      WHERE is_blocked = FALSE
        AND verified_at IS NOT NULL
        AND last_seen_at > NOW() - (${ACTIVE_DAYS} || ' days')::interval
    `);

    // Installs we have heard from but could not check: counted, never
    // published as impact. Shown so the gap is visible rather than hidden.
    const reported = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM installs
      WHERE is_blocked = FALSE
        AND verified_at IS NULL
        AND last_seen_at > NOW() - (${ACTIVE_DAYS} || ' days')::interval
    `);

    const countries = await db.execute(sql`
      SELECT COUNT(DISTINCT country)::int AS n
      FROM installs
      WHERE is_blocked = FALSE
        AND country IS NOT NULL
        AND verified_at IS NOT NULL
        AND last_seen_at > NOW() - (${ACTIVE_DAYS} || ' days')::interval
    `);

    const t = (totals.rows[0] ?? {}) as Record<string, unknown>;
    const fixed = Number(t.repairs_fixed ?? 0);
    const closed = fixed + Number(t.repairs_not_fixed ?? 0);

    const body = {
      installs: Number(t.installs ?? 0),
      countries: Number((countries.rows[0] as Record<string, unknown> | undefined)?.n ?? 0),
      sessionsHeld: Number(t.sessions_held ?? 0),
      volunteers: Number(t.volunteers ?? 0),
      repairsRecorded: Number(t.repairs_recorded ?? 0),
      repairsFixed: fixed,
      successRate: closed > 0 ? Math.round((fixed / closed) * 100) : 0,
      co2SavedKg: Math.round(Number(t.co2_saved_kg ?? 0) * 10) / 10,
      // Said out loud, because it is the honest caveat: cafes that chose not
      // to share are invisible here, so every figure is a floor.
      reportedInstalls: Number((reported.rows[0] as Record<string, unknown> | undefined)?.n ?? 0),
      note:
        'Counts only the cafés that chose to share their numbers and whose own site we could check, so these are a minimum.',
      activeWithinDays: ACTIVE_DAYS,
      generatedAt: new Date().toISOString(),
    };
    cached = { at: Date.now(), body };
    return body;
  });

  /**
   * The pins for the map, which is v2 on the public site but cheap to serve
   * now. Only installs that chose the Community level appear, and only the
   * ones that gave us somewhere to put a pin.
   */
  app.get('/api/v1/public/map', async (_request, reply) => {
    void reply.header('Cache-Control', 'public, max-age=300');
    // Verified installs only, and the name is the one that site served us
    // rather than one anybody could type. A slug is not proof of anything and
    // is no longer resolved: see docs/proposal-verified-telemetry.md.
    const rows = await db.execute(sql`
      SELECT
        cafe_name, cafe_url, cafe_slug, verified_host, country,
        cafe_lat, cafe_lng,
        verified_repairs_fixed, verified_sessions_held, verified_co2_saved_kg
      FROM installs
      WHERE level = 'community'
        AND is_blocked = FALSE
        AND verified_at IS NOT NULL
        AND last_seen_at > NOW() - (${ACTIVE_DAYS} || ' days')::interval
      ORDER BY cafe_name
    `);

    // Where the pin comes from.
    //
    // Own coordinates win. Otherwise the repaircafe.org listing may supply
    // them, but ONLY when the website that listing names is the same host we
    // just verified. Without that check a cafe could prove it controls its own
    // domain and then claim somebody else's slug to borrow their address. The
    // directory is a convenience here, never a credential: `external_link` is
    // free text a cafe typed in years ago.
    const cafes = await Promise.all(
      rows.rows.map(async (r: any) => {
        let lat = r.cafe_lat === null ? null : Number(r.cafe_lat);
        let lng = r.cafe_lng === null ? null : Number(r.cafe_lng);
        let placedBy: 'itself' | 'its repaircafe.org listing' | null = lat === null ? null : 'itself';
        if (lat === null && r.cafe_slug && r.verified_host) {
          const listed = await lookupSlug(r.cafe_slug);
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

/** Called after a write so the next reader does not get a stale summary. */
export function clearSummaryCache(): void {
  cached = null;
}
