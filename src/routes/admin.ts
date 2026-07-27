import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { env } from '../env.js';
import { bearerFrom } from '../lib/tokens.js';

/**
 * The view for us. One shared token in the environment, sent as a bearer
 * header. There are no accounts here because there is one reader.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (request, reply) => {
    const presented = bearerFrom(request.headers.authorization) ?? '';
    const a = Buffer.from(presented.padEnd(64, '\0').slice(0, 64));
    const b = Buffer.from(env.ADMIN_TOKEN.padEnd(64, '\0').slice(0, 64));
    if (presented.length === 0 || !crypto.timingSafeEqual(a, b)) {
      reply.code(401).send({ error: 'Not for you', code: 'admin/unauthorised' });
    }
  });

  /** Who is out there, newest contact first. */
  app.get('/api/v1/admin/installs', async (request) => {
    const q = request.query as { limit?: string };
    const limit = Math.max(1, Math.min(500, Number(q.limit) || 100));
    const rows = await db.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (install_id) *
        FROM pings ORDER BY install_id, received_at DESC
      )
      SELECT
        i.id, i.created_at, i.last_seen_at, i.app_version, i.level, i.country,
        i.cafe_name, i.is_blocked,
        l.repairs_recorded, l.repairs_fixed, l.sessions_held, l.co2_saved_kg,
        (SELECT COUNT(*)::int FROM pings p WHERE p.install_id = i.id) AS ping_count
      FROM installs i
      LEFT JOIN latest l ON l.install_id = i.id
      ORDER BY i.last_seen_at DESC
      LIMIT ${limit}
    `);
    return { installs: rows.rows };
  });

  /** How the fleet is doing: versions, activity, growth. */
  app.get('/api/v1/admin/overview', async () => {
    const versions = await db.execute(sql`
      SELECT COALESCE(app_version, 'unknown') AS version, COUNT(*)::int AS installs
      FROM installs WHERE is_blocked = FALSE
      GROUP BY 1 ORDER BY installs DESC
    `);
    const activity = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '2 days')::int  AS seen_2d,
        COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '45 days')::int AS seen_45d,
        COUNT(*) FILTER (WHERE level = 'community')::int                       AS on_the_map,
        COUNT(*) FILTER (WHERE is_blocked)::int                                AS blocked
      FROM installs
    `);
    const newPerWeek = await db.execute(sql`
      SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week,
             COUNT(*)::int AS installs
      FROM installs
      WHERE created_at > NOW() - INTERVAL '26 weeks'
      GROUP BY 1 ORDER BY 1
    `);
    return {
      activity: activity.rows[0] ?? {},
      versions: versions.rows,
      newPerWeek: newPerWeek.rows,
    };
  });

  /** Silence a noisy or broken install without a deploy. */
  app.post('/api/v1/admin/installs/:id/block', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { blocked?: boolean };
    const blocked = body.blocked !== false;
    const result = await db.execute(sql`
      UPDATE installs SET is_blocked = ${blocked} WHERE id = ${id}::uuid RETURNING id
    `);
    if (result.rows.length === 0) {
      reply.code(404).send({ error: 'No such install', code: 'admin/not_found' });
      return;
    }
    return { ok: true, id, blocked };
  });
}
