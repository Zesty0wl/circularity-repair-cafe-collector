/**
 * The Repair Cafe Hub telemetry collector, as a Cloudflare Worker.
 *
 *   fetch      /api/* and /health (src/app.ts). The page and its files are
 *              static assets and never reach this code.
 *   scheduled  once a day, refresh our copy of the repaircafe.org directory
 *              (services/directory.ts), which places pins for cafes that gave
 *              a slug rather than coordinates.
 */
import { handle } from './app.js';
import { database } from './db/index.js';
import type { Env } from './env.js';
import { refreshDirectory } from './services/directory.js';

export { Limiter } from './limiter.js';

export default {
  fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      refreshDirectory(database(env.DB)).then(
        (n) => console.log(JSON.stringify({ msg: 'directory refreshed', cafes: n })),
        (err) => console.warn(JSON.stringify({ msg: 'directory refresh failed, keeping the old copy', err: String(err) })),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
