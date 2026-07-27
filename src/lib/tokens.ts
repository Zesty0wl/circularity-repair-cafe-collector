import crypto from 'node:crypto';

/**
 * An install gets a token the first time it says hello, and sends it with
 * every ping after that. We keep only the hash, so a copy of the database is
 * not a set of working credentials.
 */
export function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Compare without leaking how much of the value matched through timing. */
export function tokensMatch(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(presented), 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** The bearer token on a request, or null if there is not one. */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/**
 * Two letters from Cloudflare's country header, or null.
 *
 * We are behind Cloudflare, so this arrives for free and we never have to
 * store an address to work out roughly where an install is. "XX" and "T1"
 * are Cloudflare's own values for unknown and Tor, and mean nothing to us.
 */
export function countryFrom(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === 'XX' || code === 'T1') return null;
  return code;
}
