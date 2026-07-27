import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /**
   * Shared secret for the endpoints only we call. Long and random, set in
   * .env. Without it those endpoints refuse to answer at all rather than
   * falling open.
   */
  ADMIN_TOKEN: z.string().min(24, 'ADMIN_TOKEN must be at least 24 characters'),
  /**
   * Trust the proxy in front of us for the client address. We sit behind
   * nginx, which sits behind Cloudflare.
   */
  TRUST_PROXY: z.string().default('true'),
  /** Largest body we will read. A real ping is a couple of kilobytes. */
  MAX_BODY_KB: z.coerce.number().int().positive().default(64),
  /** How far a client's clock may be out before we reject the ping, in hours. */
  MAX_CLOCK_SKEW_HOURS: z.coerce.number().int().positive().default(48),
  TZ: z.string().default('UTC'),
});

export const env = envSchema.parse(process.env);
export type Env = typeof env;
