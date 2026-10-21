import { eq } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { installs } from '../db/schema.js';
import type { Env } from '../env.js';

/**
 * Proving an install is real
 * ──────────────────────────
 * Anyone can post numbers. Nobody can post numbers *and* serve our install id
 * from a domain they do not control. So we do not believe a ping until we have
 * fetched the sender's own site and found the same id looking back at us.
 *
 * This is the ACME HTTP-01 idea. It does not make faking impossible: it makes
 * one fake cafe cost a domain, a certificate and a served endpoint, each time.
 * That is a large change from `curl`, and claiming more would be dishonest.
 *
 * ── The danger ──────────────────────────────────────────────────────────────
 * Fetching a URL a stranger chose is server-side request forgery. In Docker
 * that meant the host's other services were one plausible `publicUrl` away,
 * and this file resolved names itself to refuse private addresses. A Worker
 * has no private network: its fetch leaves through Cloudflare, and the
 * `global_fetch_strictly_public` flag in wrangler.jsonc sends even our own
 * zones out over the public internet. What is left is not letting a stranger
 * aim us at somebody else, and these rules stay for that:
 *
 *   - https only, and a name rather than a bare address
 *   - no redirects, because a redirect is a second URL nobody checked
 *   - a fixed path, never one from the payload
 *   - short timeout, small size cap
 *   - the fetched body never reaches the caller, so a blind probe learns nothing
 *   - a per-install cooldown, and a ceiling across all installs
 */

/** Where a hub answers. Fixed here; never taken from the payload. */
const VERIFY_PATH = '/api/public/telemetry';
const TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;
/** Re-check roughly daily, matching the ping rhythm. */
export const RECHECK_AFTER_MS = 20 * 60 * 60 * 1000;

const USER_AGENT =
  'CircularityRepairCafeTelemetry/1.0 verification (+https://github.com/Zesty0wl/circularity-repair-cafe-collector)';

export interface VerifyOutcome {
  ok: boolean;
  /** Why not, in words a person can act on. Stored, never shown to the sender. */
  error?: string;
  host?: string;
  name?: string | null;
  figures?: {
    repairsRecorded: number;
    repairsFixed: number;
    repairsNotFixed: number;
    sessionsHeld: number;
    volunteers: number;
    co2SavedKg: number;
  };
}

/** A hostname that is really an address: four numbers, or anything with a colon (IPv6). */
function isBareAddress(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
}

/** The URL a hub may be checked at, or null if it is not one we will fetch. */
export function verifiableUrl(publicUrl: string | null | undefined): URL | null {
  if (!publicUrl) return null;
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return null;
  }
  // Plain http proves nothing: there is no identity behind it to check.
  if (url.protocol !== 'https:') return null;
  if (!url.hostname.includes('.')) return null;
  // A bare IP address has no name to prove and no certificate that would
  // validate against it.
  if (isBareAddress(url.hostname)) return null;
  // Anything the sender put in the path, query or fragment is discarded.
  return new URL(VERIFY_PATH, `https://${url.host}`);
}

/**
 * Fetch a hub's own endpoint and see whether it agrees that it is this install.
 *
 * Never throws: a cafe being offline is ordinary, not an error in us.
 */
export async function verifyInstall(installId: string, publicUrl: string | null): Promise<VerifyOutcome> {
  const target = verifiableUrl(publicUrl);
  if (!target) return { ok: false, error: 'no usable https address was given' };

  try {
    const res = await fetch(target, {
      method: 'GET',
      // A redirect is a second URL nobody checked, so we look at it rather
      // than follow it, and refuse it below.
      redirect: 'manual',
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      void res.body?.cancel();
      return { ok: false, error: `the hub redirected (${res.status}), and we do not follow redirects` };
    }
    if (!res.ok) {
      void res.body?.cancel();
      return {
        ok: false,
        error: res.status === 404 ? 'that hub is not sharing its numbers' : `the hub answered ${res.status}`,
      };
    }

    // Read with a ceiling rather than trusting content-length.
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, error: 'the hub sent nothing' };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        void reader.cancel();
        return { ok: false, error: 'the hub sent more than we will read' };
      }
      chunks.push(value);
    }
    const decoder = new TextDecoder();
    const text = chunks.map((c) => decoder.decode(c, { stream: true })).join('') + decoder.decode();

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: false, error: 'the hub did not answer with JSON' };
    }
    if (!body || typeof body !== 'object') return { ok: false, error: 'the hub did not answer with JSON' };

    // The whole point: does the site claim the same install as the ping did?
    if (body.installId !== installId) {
      return { ok: false, error: 'that site belongs to a different install' };
    }

    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    return {
      ok: true,
      host: target.hostname,
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 200) : null,
      figures: {
        repairsRecorded: num(body.repairsRecorded),
        repairsFixed: num(body.repairsFixed),
        repairsNotFixed: num(body.repairsNotFixed),
        sessionsHeld: num(body.sessionsHeld),
        volunteers: num(body.volunteers),
        co2SavedKg: num(body.co2SavedKg),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'the check failed';
    return { ok: false, error: message.slice(0, 200) };
  }
}

/**
 * Check an install if it is due, and record what happened.
 *
 * Handed to ctx.waitUntil after a ping: a slow or unreachable cafe must never
 * hold up the reply to it.
 */
export async function verifyIfDue(db: DB, env: Env, installId: string, publicUrl: string | null): Promise<void> {
  try {
    const [row] = await db.select().from(installs).where(eq(installs.id, installId)).limit(1);
    if (!row) return;
    // The cooldown must key on when we last LOOKED, not on when we last
    // succeeded. Keying on verifiedAt meant an install that never verifies has
    // no cooldown at all, so every ping sent us out to fetch whatever URL it
    // named: point a fake install at somebody else's website and we become
    // their traffic. A failing check is exactly the case that needs the brake.
    const lastLooked = row.verifyCheckedAt ?? row.verifiedAt;
    if (lastLooked && Date.now() - lastLooked.getTime() < RECHECK_AFTER_MS) return;

    // A ceiling on outbound checks across all installs. The cooldown stops one
    // sender making us hammer a site; this stops many senders adding up to the
    // same thing. Verification is the only thing here that makes requests to
    // other people's servers, so it is the only thing that can be turned into a
    // weapon.
    const { success } = await env.VERIFY_LIMIT.limit({ key: 'verify' });
    if (!success) {
      console.warn(JSON.stringify({ installId, msg: 'skipping verification: too many outbound checks this minute' }));
      return;
    }

    const outcome = await verifyInstall(installId, publicUrl);
    await db
      .update(installs)
      .set({
        verifiedAt: outcome.ok ? new Date() : null,
        verifiedHost: outcome.ok ? (outcome.host ?? null) : null,
        verifyCheckedAt: new Date(),
        verifyError: outcome.ok ? null : (outcome.error ?? 'the check failed'),
        // The figures we publish are the ones we fetched ourselves, not the
        // ones we were handed. Two numbers minutes apart would disagree, and
        // the fetched one is the only one anybody can check.
        ...(outcome.ok && outcome.figures
          ? {
              verifiedRepairsRecorded: outcome.figures.repairsRecorded,
              verifiedRepairsFixed: outcome.figures.repairsFixed,
              verifiedRepairsNotFixed: outcome.figures.repairsNotFixed,
              verifiedSessionsHeld: outcome.figures.sessionsHeld,
              verifiedVolunteers: outcome.figures.volunteers,
              verifiedCo2SavedKg: outcome.figures.co2SavedKg,
              ...(outcome.name ? { cafeName: outcome.name } : {}),
            }
          : {}),
      })
      .where(eq(installs.id, installId));

    if (outcome.ok) console.log(JSON.stringify({ installId, host: outcome.host, msg: 'install verified' }));
    else console.log(JSON.stringify({ installId, reason: outcome.error, msg: 'install not verified' }));
  } catch (err) {
    console.warn(JSON.stringify({ err: String(err), msg: 'verification failed unexpectedly' }));
  }
}
