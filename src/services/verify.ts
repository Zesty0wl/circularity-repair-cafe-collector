import dns from 'node:dns/promises';
import net from 'node:net';
import { db } from '../db/index.js';
import { installs } from '../db/schema.js';
import { eq } from 'drizzle-orm';

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
 * Fetching a URL a stranger chose is server-side request forgery. From inside
 * this container the Docker host's other services are reachable: a plausible
 * `publicUrl` of http://172.17.0.1:5433 would turn this into a probe against
 * somebody's database. Every rule below exists for that reason, and none of
 * them is optional:
 *
 *   - https only
 *   - resolve the name first, and reject every address that is not public
 *   - connect to the address we checked, carrying the hostname in Host and SNI,
 *     so a name cannot resolve to something else between check and connect
 *   - no redirects, because a redirect is a second URL nobody checked
 *   - a fixed path, never one from the payload
 *   - short timeout, small size cap
 *   - the fetched body never reaches the caller, so a blind probe learns nothing
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

/**
 * Is this address one we are willing to open a connection to?
 *
 * Everything private, local, or otherwise not on the public internet is
 * refused. The list is deliberately long: the failure mode of missing one is
 * that our server becomes somebody's port scanner.
 */
export function isPublicAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = p as [number, number, number, number];
    if (a === 0) return false;                         // this network
    if (a === 10) return false;                        // private
    if (a === 127) return false;                       // loopback
    if (a === 169 && b === 254) return false;          // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false; // private, incl. the docker bridge
    if (a === 192 && b === 168) return false;          // private
    if (a === 100 && b >= 64 && b <= 127) return false;// carrier-grade NAT
    if (a === 192 && b === 0) return false;            // IETF protocol assignments
    if (a >= 224) return false;                        // multicast and reserved
    return true;
  }
  if (kind === 6) {
    const v = ip.toLowerCase().split('%')[0]!;
    if (v === '::' || v === '::1') return false;       // unspecified, loopback
    if (v.startsWith('fe80')) return false;            // link-local
    if (/^f[cd]/.test(v)) return false;                // unique local
    if (v.startsWith('ff')) return false;              // multicast
    // ::ffff:a.b.c.d — an IPv4 address wearing a hat.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPublicAddress(mapped[1]!);
    return true;
  }
  return false;
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
  // validate against it. The address check below would refuse a private one
  // anyway; refusing it here as well means the two gates fail independently.
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) return null;
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

  // Resolve first, and refuse anything that is not on the public internet.
  let addresses: string[];
  try {
    const found = await dns.lookup(target.hostname, { all: true, verbatim: true });
    addresses = found.map((a) => a.address);
  } catch {
    return { ok: false, error: 'the address does not resolve' };
  }
  if (addresses.length === 0) return { ok: false, error: 'the address does not resolve' };
  const bad = addresses.find((a) => !isPublicAddress(a));
  if (bad) return { ok: false, error: `refused: ${target.hostname} resolves to ${bad}, which is not a public address` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      method: 'GET',
      redirect: 'error', // a redirect is a second URL nobody checked
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) {
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
    const text = Buffer.concat(chunks).toString('utf8');

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: false, error: 'the hub did not answer with JSON' };
    }

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
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check an install if it is due, and record what happened.
 *
 * Called after a ping and deliberately not awaited: a slow or unreachable cafe
 * must never hold up the reply to a different one.
 */
export async function verifyIfDue(
  installId: string,
  publicUrl: string | null,
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void },
): Promise<void> {
  try {
    const [row] = await db.select().from(installs).where(eq(installs.id, installId)).limit(1);
    if (!row) return;
    if (row.verifiedAt && Date.now() - row.verifiedAt.getTime() < RECHECK_AFTER_MS) return;

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
              verifiedCo2SavedKg: String(outcome.figures.co2SavedKg),
              ...(outcome.name ? { cafeName: outcome.name } : {}),
            }
          : {}),
      })
      .where(eq(installs.id, installId));

    if (outcome.ok) log.info({ installId, host: outcome.host }, 'install verified');
    else log.info({ installId, reason: outcome.error }, 'install not verified');
  } catch (err) {
    log.warn({ err }, 'verification failed unexpectedly');
  }
}
