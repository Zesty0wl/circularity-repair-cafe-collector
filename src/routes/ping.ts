import { eq } from 'drizzle-orm';
import { database } from '../db/index.js';
import { installs, pings } from '../db/schema.js';
import { numberVar, type Env } from '../env.js';
import { cafeDetailsFor, pingSchema } from '../lib/payload.js';
import { bearerFrom, countryFrom, hashToken, newToken, tokensMatch } from '../lib/tokens.js';
import { clientAddress, json, problem, readJson, tooMany } from '../lib/http.js';
import { limitFor } from '../limiter.js';
import { verifyIfDue } from '../services/verify.js';

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

/**
 * A returning install pings once a day; 30 an hour leaves room for a restart
 * loop and a retry. Creating a *new* install is far rarer and has its own
 * limit, because one limit for both allowed thirty new cafes an hour from a
 * single address. Somebody setting up a cafe does this once. Anything doing it
 * repeatedly is not setting up cafes.
 */
const PINGS_PER_HOUR = 30;
const NEW_INSTALLS_PER_HOUR = 3;
const FORGETS_PER_HOUR = 10;

/** cf.country is Cloudflare's idea of where the request came from. */
function countryOf(request: Request): string | null {
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  return countryFrom(cf?.country ?? request.headers.get('CF-IPCountry') ?? undefined);
}

export async function ping(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const address = clientAddress(request);
  const limiter = await limitFor(env, address);
  if (!(await limiter.take('ping', PINGS_PER_HOUR))) return tooMany(3600);

  const parsed = pingSchema.safeParse(await readJson(request, numberVar(env.MAX_BODY_KB, 64) * 1024));
  if (!parsed.success) {
    return problem(400, 'That is not a summary we recognise', 'ping/invalid', {
      details: parsed.error.flatten(),
    });
  }
  const body = parsed.data;

  // A clock that is badly wrong makes the history meaningless, and a
  // future date is the easiest way to poison a chart.
  const sentAt = new Date(body.sentAt);
  const skewHours = Math.abs(Date.now() - sentAt.getTime()) / 3_600_000;
  if (!Number.isFinite(skewHours) || skewHours > numberVar(env.MAX_CLOCK_SKEW_HOURS, 48)) {
    return problem(400, 'The clock on that install is too far out for us to use', 'ping/clock_skew');
  }

  const db = database(env.DB);
  const presented = bearerFrom(request.headers.get('authorization') ?? undefined);
  const country = countryOf(request);
  const cafe = cafeDetailsFor(body);
  const [existing] = await db.select().from(installs).where(eq(installs.id, body.installId)).limit(1);

  const pingRow = db.insert(pings).values({
    installId: body.installId,
    sentAt,
    appVersion: body.app.version,
    payload: body,
    sessionsHeld: body.howManySessions ?? null,
    volunteers: body.howManyVolunteers ?? null,
    repairsRecorded: body.repairsRecorded ?? null,
    repairsFixed: body.repairsFixed ?? null,
    repairsNotFixed: body.repairsNotFixed ?? null,
    co2SavedKg: body.co2?.savedKg ?? null,
  });

  let issuedToken: string | null = null;

  if (!existing) {
    // First hello. Anyone can claim an id nobody has claimed yet, which is
    // fine: an id on its own says nothing, and whoever claims it is the
    // only one who can ever write to it afterwards. What is not fine is
    // doing it repeatedly, so first contact has its own tighter limit.
    if (presented) return problem(401, 'Unknown install', 'ping/unknown_install');
    if (!(await limiter.take('new-install', NEW_INSTALLS_PER_HOUR))) {
      return problem(429, 'Too many new installs from here. Try again later.', 'ping/too_many_new');
    }
    issuedToken = newToken();
    await db.batch([
      db.insert(installs).values({
        id: body.installId,
        tokenHash: hashToken(issuedToken),
        appVersion: body.app.version,
        level: body.level,
        country,
        cafeSlug: cafe.slug,
        cafeName: cafe.name,
        cafeUrl: cafe.url,
        cafeLat: cafe.lat,
        cafeLng: cafe.lng,
      }),
      pingRow,
    ]);
  } else {
    if (!presented || !tokensMatch(presented, existing.tokenHash)) {
      return problem(401, 'That token does not match', 'ping/bad_token');
    }
    if (existing.isBlocked) {
      // Answer politely and drop it. Telling a blocked install that it is
      // blocked only invites it to change its id.
      return json({ ok: true, nextPingAfterHours: 168 }, 202);
    }
    await db.batch([
      db
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
          cafeLat: cafe.lat,
          cafeLng: cafe.lng,
        })
        .where(eq(installs.id, body.installId)),
      pingRow,
    ]);
  }

  // Check that this install is what it says it is, without making the
  // sender wait for it. A cafe that is slow or offline must not hold up
  // the reply, and the outcome only affects what we publish tomorrow.
  ctx.waitUntil(verifyIfDue(db, env, body.installId, cafe.url));

  // Tell the hub how it is doing, so a cafe is never left wondering why
  // its numbers are missing. The commonest cause is a publicUrl saved as
  // http://127.0.0.1:5026, because setup was done down an SSH tunnel, and
  // without this the cafe would never find out.
  const [after] = await db
    .select({ verifiedAt: installs.verifiedAt, verifyError: installs.verifyError })
    .from(installs)
    .where(eq(installs.id, body.installId))
    .limit(1);

  // `token` appears exactly once, on the call that mints it.
  // `nextPingAfterHours` lets us slow every install down later without
  // shipping new client code, which is a lever worth having on day one.
  return json({
    ok: true,
    ...(issuedToken ? { token: issuedToken } : {}),
    nextPingAfterHours: 24,
    verification: {
      verified: Boolean(after?.verifiedAt),
      // Null on the very first ping, because the check is still running.
      reason: after?.verifiedAt ? null : (after?.verifyError ?? null),
      // Said plainly, because it is the actionable part.
      help: after?.verifiedAt
        ? null
        : 'Your numbers are counted only once we can fetch /api/public/telemetry from your public web address. Check Settings, Cafe profile, Public URL.',
    },
  });
}

/**
 * Forget everything about this install. The row goes, and its pings go with
 * it through the foreign key. Deliberately unauthenticated beyond the
 * token: somebody asking to be deleted should never have to ask us twice.
 */
export async function forget(request: Request, env: Env): Promise<Response> {
  const limiter = await limitFor(env, clientAddress(request));
  if (!(await limiter.take('forget', FORGETS_PER_HOUR))) return tooMany(3600);

  const body = ((await readJson(request, numberVar(env.MAX_BODY_KB, 64) * 1024)) ?? {}) as {
    installId?: unknown;
  };
  const installId = typeof body.installId === 'string' ? body.installId : null;
  const presented = bearerFrom(request.headers.get('authorization') ?? undefined);
  if (!installId || !presented) {
    return problem(400, 'installId and a token are required', 'forget/incomplete');
  }
  const db = database(env.DB);
  const [existing] = await db.select().from(installs).where(eq(installs.id, installId)).limit(1);
  if (!existing || !tokensMatch(presented, existing.tokenHash)) {
    // Same answer either way, so this cannot be used to find out which
    // install ids exist.
    return problem(404, 'Nothing to forget', 'forget/not_found');
  }
  await db.delete(installs).where(eq(installs.id, installId));
  console.log(JSON.stringify({ installId, msg: 'install asked to be forgotten' }));
  return json({ ok: true, forgotten: true });
}
