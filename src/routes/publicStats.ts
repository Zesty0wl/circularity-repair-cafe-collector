import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

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

    const totals = await db.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (p.install_id) p.*
        FROM pings p
        JOIN installs i ON i.id = p.install_id
        WHERE i.is_blocked = FALSE
          AND i.last_seen_at > NOW() - (${ACTIVE_DAYS} || ' days')::interval
        ORDER BY p.install_id, p.received_at DESC
      )
      SELECT
        COUNT(*)::int                                   AS installs,
        COALESCE(SUM(sessions_held), 0)::int            AS sessions_held,
        COALESCE(SUM(volunteers), 0)::int               AS volunteers,
        COALESCE(SUM(repairs_recorded), 0)::int         AS repairs_recorded,
        COALESCE(SUM(repairs_fixed), 0)::int            AS repairs_fixed,
        COALESCE(SUM(repairs_not_fixed), 0)::int        AS repairs_not_fixed,
        COALESCE(SUM(co2_saved_kg), 0)::float           AS co2_saved_kg
      FROM latest
    `);
    const t = (totals.rows[0] ?? {}) as Record<string, unknown>;

    const countries = await db.execute(sql`
      SELECT COUNT(DISTINCT country)::int AS n
      FROM installs
      WHERE is_blocked = FALSE
        AND country IS NOT NULL
        AND last_seen_at > NOW() - (${ACTIVE_DAYS} || ' days')::interval
    `);

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
      note: 'Counts only the cafes that chose to share their numbers, so these are a minimum.',
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
    const rows = await db.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (p.install_id) p.*
        FROM pings p
        ORDER BY p.install_id, p.received_at DESC
      )
      SELECT
        i.cafe_name, i.cafe_slug, i.cafe_url, i.cafe_lat, i.cafe_lng, i.country,
        l.repairs_fixed, l.sessions_held, l.co2_saved_kg
      FROM installs i
      JOIN latest l ON l.install_id = i.id
      WHERE i.level = 'community'
        AND i.is_blocked = FALSE
        AND i.last_seen_at > NOW() - (${ACTIVE_DAYS} || ' days')::interval
        AND (i.cafe_slug IS NOT NULL OR (i.cafe_lat IS NOT NULL AND i.cafe_lng IS NOT NULL))
      ORDER BY i.cafe_name
    `);
    return {
      cafes: rows.rows.map((r: any) => ({
        name: r.cafe_name,
        // A pin can be looked up from the repaircafe.org directory by slug,
        // which is why a cafe on that directory need send us no location.
        repaircafeSlug: r.cafe_slug,
        url: r.cafe_url,
        lat: r.cafe_lat === null ? null : Number(r.cafe_lat),
        lng: r.cafe_lng === null ? null : Number(r.cafe_lng),
        country: r.country,
        repairsFixed: Number(r.repairs_fixed ?? 0),
        sessionsHeld: Number(r.sessions_held ?? 0),
        co2SavedKg: Math.round(Number(r.co2_saved_kg ?? 0) * 10) / 10,
      })),
      generatedAt: new Date().toISOString(),
    };
  });
}

/** Called after a write so the next reader does not get a stale summary. */
export function clearSummaryCache(): void {
  cached = null;
}
