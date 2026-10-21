import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { database } from '../db/index.js';
import type { Env } from '../env.js';
import { bearerFrom } from '../lib/tokens.js';
import { clientAddress, json, problem, readJson, tooMany } from '../lib/http.js';

/**
 * The view for us. One shared token, set with `wrangler secret put
 * ADMIN_TOKEN`, sent as a bearer header. There are no accounts here because
 * there is one reader.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Milliseconds since 1970 as the ISO text Postgres used to hand back. */
function iso(ms: unknown): string | null {
  return typeof ms === 'number' ? new Date(ms).toISOString() : null;
}

/**
 * Rate limit first, then the token, as Fastify did. 30 a minute is generous
 * for one human reader and mean for anything guessing at the token.
 */
async function admitted(request: Request, env: Env): Promise<Response | null> {
  const { success } = await env.ADMIN_LIMIT.limit({ key: clientAddress(request) });
  if (!success) return tooMany(60);
  const presented = bearerFrom(request.headers.get('authorization') ?? undefined) ?? '';
  // No token configured means nobody gets in, never that everybody does.
  if (presented.length === 0 || !env.ADMIN_TOKEN) {
    return problem(401, 'Not for you', 'admin/unauthorised');
  }
  // Compare fixed-length hashes rather than the strings themselves. Padding
  // the raw values meant a multi-byte token produced buffers of different
  // byte lengths, timingSafeEqual threw, and the reply was a 500 rather than
  // a 401. Two sha256 digests are always 32 bytes, whatever was sent.
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(env.ADMIN_TOKEN).digest();
  if (!crypto.timingSafeEqual(a, b)) return problem(401, 'Not for you', 'admin/unauthorised');
  return null;
}

/** Who is out there, newest contact first. */
export async function listInstalls(request: Request, env: Env): Promise<Response> {
  const refused = await admitted(request, env);
  if (refused) return refused;
  const limit = Math.max(1, Math.min(500, Number(new URL(request.url).searchParams.get('limit')) || 100));
  const db = database(env.DB);
  const rows = await db.all<Record<string, unknown>>(sql`
    WITH latest AS (
      SELECT * FROM (
        SELECT p.*, ROW_NUMBER() OVER (PARTITION BY install_id ORDER BY received_at DESC) AS rn
        FROM pings p
      ) WHERE rn = 1
    )
    SELECT
      i.id, i.created_at, i.last_seen_at, i.app_version, i.level, i.country,
      i.cafe_name, i.is_blocked,
      l.repairs_recorded, l.repairs_fixed, l.sessions_held, l.co2_saved_kg,
      (SELECT COUNT(*) FROM pings p WHERE p.install_id = i.id) AS ping_count
    FROM installs i
    LEFT JOIN latest l ON l.install_id = i.id
    ORDER BY i.last_seen_at DESC
    LIMIT ${limit}
  `);
  return json({
    installs: rows.map((r) => ({
      ...r,
      created_at: iso(r.created_at),
      last_seen_at: iso(r.last_seen_at),
      is_blocked: Boolean(r.is_blocked),
    })),
  });
}

/** How the fleet is doing: versions, activity, growth. */
export async function overview(request: Request, env: Env): Promise<Response> {
  const refused = await admitted(request, env);
  if (refused) return refused;
  const db = database(env.DB);
  const now = Date.now();
  const versions = await db.all(sql`
    SELECT COALESCE(app_version, 'unknown') AS version, COUNT(*) AS installs
    FROM installs WHERE is_blocked = 0
    GROUP BY 1 ORDER BY installs DESC
  `);
  const [activity] = await db.all(sql`
    SELECT
      COUNT(*)                                                    AS total,
      COUNT(*) FILTER (WHERE last_seen_at > ${now - 2 * DAY_MS})  AS seen_2d,
      COUNT(*) FILTER (WHERE last_seen_at > ${now - 45 * DAY_MS}) AS seen_45d,
      COUNT(*) FILTER (WHERE level = 'community')                 AS on_the_map,
      COUNT(*) FILTER (WHERE is_blocked = 1)                      AS blocked
    FROM installs
  `);
  // Weeks start on Monday, as Postgres's date_trunc('week') did: move forward
  // to the Sunday ending the week, then back six days.
  const newPerWeek = await db.all(sql`
    SELECT date(created_at / 1000, 'unixepoch', 'weekday 0', '-6 days') AS week,
           COUNT(*) AS installs
    FROM installs
    WHERE created_at > ${now - 26 * 7 * DAY_MS}
    GROUP BY 1 ORDER BY 1
  `);
  return json({ activity: activity ?? {}, versions, newPerWeek });
}

/** Silence a noisy or broken install without a deploy. */
export async function block(request: Request, env: Env, id: string): Promise<Response> {
  const refused = await admitted(request, env);
  if (refused) return refused;
  const body = ((await readJson(request, 4096)) ?? {}) as { blocked?: unknown };
  const blocked = body.blocked !== false;
  const db = database(env.DB);
  const rows = await db.all(sql`
    UPDATE installs SET is_blocked = ${blocked ? 1 : 0} WHERE id = ${id} RETURNING id
  `);
  if (rows.length === 0) return problem(404, 'No such install', 'admin/not_found');
  return json({ ok: true, id, blocked });
}
