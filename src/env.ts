import type { Limiter } from './limiter.js';

/** What wrangler.jsonc and `wrangler secret put` give the Worker. */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  LIMITER: DurableObjectNamespace<Limiter>;
  /** 120 a minute per address across the API, as a backstop. */
  BACKSTOP_LIMIT: RateLimit;
  /** 30 a minute per address on the admin endpoints. */
  ADMIN_LIMIT: RateLimit;
  /** 30 outbound verification checks a minute, across all installs. */
  VERIFY_LIMIT: RateLimit;

  /**
   * Shared secret for the endpoints only we call. Long and random. Without it
   * those endpoints refuse to answer at all rather than falling open.
   */
  ADMIN_TOKEN?: string;
  /**
   * Key for the hash that names an address's rate-limit counter, so the
   * counters never hold an address. Long and random.
   */
  LIMIT_SECRET?: string;

  /** How far a client's clock may be out before we reject the ping, in hours. */
  MAX_CLOCK_SKEW_HOURS?: string;
  /** Largest body we will read. A real ping is a couple of kilobytes. */
  MAX_BODY_KB?: string;
}

export function numberVar(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
