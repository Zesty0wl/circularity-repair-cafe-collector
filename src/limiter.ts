import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.js';

/**
 * Limits counted over an hour
 * ───────────────────────────
 * Cloudflare's rate limiting binding only counts in windows of 10 or 60
 * seconds, and our slow limits are per hour: 30 pings, 3 new installs and 10
 * forget requests from one address. So each address gets one of these.
 *
 * It is named by a keyed hash of the address (limitFor below), so nothing in
 * here, its name included, is an address. What it keeps is a list of times,
 * in its own storage rather than in memory: an idle Durable Object is evicted
 * within minutes, and a counter that forgets on eviction lets anybody who
 * pauses between tries start again from zero. An alarm wipes the lot once the
 * newest entry is an hour old.
 */

const WINDOW_MS = 60 * 60 * 1000;

export class Limiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS hits (kind TEXT NOT NULL, at INTEGER NOT NULL)');
  }

  /**
   * Count one `kind` of request if fewer than `limit` happened in the last
   * hour, and say whether it was allowed. A refused request is not counted,
   * so being refused does not keep you refused.
   */
  async take(kind: string, limit: number): Promise<boolean> {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM hits WHERE at <= ?', now - WINDOW_MS);
    const row = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM hits WHERE kind = ?', kind).one();
    if (row.n >= limit) return false;
    sql.exec('INSERT INTO hits (kind, at) VALUES (?, ?)', kind, now);
    await this.ctx.storage.setAlarm(now + WINDOW_MS);
    return true;
  }

  async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM hits WHERE at <= ?', Date.now() - WINDOW_MS);
    const row = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM hits').one();
    if (row.n === 0) await this.ctx.storage.deleteAll();
  }
}

/** The counter for this address, named so that it does not say which address. */
export async function limitFor(env: Env, address: string): Promise<DurableObjectStub<Limiter>> {
  const secret = env.LIMIT_SECRET;
  if (!secret) throw new Error('LIMIT_SECRET is not set');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(address));
  const name = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return env.LIMITER.get(env.LIMITER.idFromName(name));
}
