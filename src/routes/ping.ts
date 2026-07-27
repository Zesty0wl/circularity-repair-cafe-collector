import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { installs, pings } from '../db/schema.js';
import { cafeDetailsFor, pingSchema } from '../lib/payload.js';
import { bearerFrom, countryFrom, hashToken, newToken, tokensMatch } from '../lib/tokens.js';
import { env } from '../env.js';

/**
 * Taking a ping
 * ─────────────
 * A hub says hello once, is given a token, and sends one summary a day after
 * that. Everything it sends is a running total, so a missed day heals itself
 * on the next send and there is nothing to queue or replay.
 *
 * The endpoint is open to the internet, so it assumes every request is junk
 * until it has proved otherwise: the body must match the schema exactly, the
 * clock must be roughly right, and the token must belong to the install id in
 * the body.
 */
export async function pingRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/v1/ping',
    {
      config: {
        // One a day is expected. This leaves room for a restart loop and a
        // retry without letting anyone use us as a firehose.
        rateLimit: { max: 30, timeWindow: '1 hour' },
      },
    },
    async (request, reply) => {
      const parsed = pingSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({
          error: 'That is not a summary we recognise',
          code: 'ping/invalid',
          details: parsed.error.flatten(),
        });
        return;
      }
      const body = parsed.data;

      // A clock that is badly wrong makes the history meaningless, and a
      // future date is the easiest way to poison a chart.
      const sentAt = new Date(body.sentAt);
      const skewHours = Math.abs(Date.now() - sentAt.getTime()) / 3_600_000;
      if (!Number.isFinite(skewHours) || skewHours > env.MAX_CLOCK_SKEW_HOURS) {
        reply.code(400).send({
          error: 'The clock on that install is too far out for us to use',
          code: 'ping/clock_skew',
        });
        return;
      }

      const presented = bearerFrom(request.headers.authorization);
      const country = countryFrom(request.headers['cf-ipcountry']);
      const cafe = cafeDetailsFor(body);
      const [existing] = await db.select().from(installs).where(eq(installs.id, body.installId)).limit(1);

      let issuedToken: string | null = null;

      if (!existing) {
        // First hello. Anyone can claim an id nobody has claimed yet, which is
        // fine: an id on its own says nothing, and whoever claims it is the
        // only one who can ever write to it afterwards.
        if (presented) {
          reply.code(401).send({ error: 'Unknown install', code: 'ping/unknown_install' });
          return;
        }
        issuedToken = newToken();
        await db.insert(installs).values({
          id: body.installId,
          tokenHash: hashToken(issuedToken),
          appVersion: body.app.version,
          level: body.level,
          country,
          cafeSlug: cafe.slug,
          cafeName: cafe.name,
          cafeUrl: cafe.url,
          cafeLat: cafe.lat === null ? null : String(cafe.lat),
          cafeLng: cafe.lng === null ? null : String(cafe.lng),
        });
      } else {
        if (!presented || !tokensMatch(presented, existing.tokenHash)) {
          reply.code(401).send({ error: 'That token does not match', code: 'ping/bad_token' });
          return;
        }
        if (existing.isBlocked) {
          // Answer politely and drop it. Telling a blocked install that it is
          // blocked only invites it to change its id.
          reply.code(202).send({ ok: true, nextPingAfterHours: 168 });
          return;
        }
        await db
          .update(installs)
          .set({
            lastSeenAt: new Date(),
            appVersion: body.app.version,
            level: body.level,
            country: country ?? existing.country,
            // Dropping to Standard must clear what Community shared, or a
            // cafe that changed its mind would stay on the map.
            cafeSlug: cafe.slug,
            cafeName: cafe.name,
            cafeUrl: cafe.url,
            cafeLat: cafe.lat === null ? null : String(cafe.lat),
            cafeLng: cafe.lng === null ? null : String(cafe.lng),
          })
          .where(eq(installs.id, body.installId));
      }

      await db.insert(pings).values({
        installId: body.installId,
        sentAt,
        appVersion: body.app.version,
        payload: body as unknown as Record<string, unknown>,
        sessionsHeld: body.howManySessions ?? null,
        volunteers: body.howManyVolunteers ?? null,
        repairsRecorded: body.repairsRecorded ?? null,
        repairsFixed: body.repairsFixed ?? null,
        repairsNotFixed: body.repairsNotFixed ?? null,
        co2SavedKg: body.co2?.savedKg === undefined ? null : String(body.co2.savedKg),
      });

      // `token` appears exactly once, on the call that mints it.
      // `nextPingAfterHours` lets us slow every install down later without
      // shipping new client code, which is a lever worth having on day one.
      return {
        ok: true,
        ...(issuedToken ? { token: issuedToken } : {}),
        nextPingAfterHours: 24,
      };
    }
  );

  /**
   * Forget everything about this install. The row goes, and its pings go with
   * it through the foreign key. Deliberately unauthenticated beyond the
   * token: somebody asking to be deleted should never have to ask us twice.
   */
  app.post(
    '/api/v1/forget',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as { installId?: string };
      const presented = bearerFrom(request.headers.authorization);
      if (!body.installId || !presented) {
        reply.code(400).send({ error: 'installId and a token are required', code: 'forget/incomplete' });
        return;
      }
      const [existing] = await db.select().from(installs).where(eq(installs.id, body.installId)).limit(1);
      if (!existing || !tokensMatch(presented, existing.tokenHash)) {
        // Same answer either way, so this cannot be used to find out which
        // install ids exist.
        reply.code(404).send({ error: 'Nothing to forget', code: 'forget/not_found' });
        return;
      }
      await db.delete(installs).where(eq(installs.id, body.installId));
      request.log.info({ installId: body.installId }, 'install asked to be forgotten');
      return { ok: true, forgotten: true };
    }
  );
}
