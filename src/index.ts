import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env.js';
import { pool } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { pingRoutes } from './routes/ping.js';
import { publicStatsRoutes } from './routes/publicStats.js';
import { adminRoutes } from './routes/admin.js';

const trustProxy = env.TRUST_PROXY === 'false' ? false : env.TRUST_PROXY === 'true' ? true : env.TRUST_PROXY;

const app = Fastify({
  logger: {
    level: env.LOG_LEVEL,
    // The address is used to rate limit and then forgotten. It is never
    // written to the database, and it should not sit in the logs either.
    redact: ['req.headers.authorization', 'req.headers.cookie', 'req.remoteAddress', 'req.hostname'],
  },
  trustProxy,
  bodyLimit: env.MAX_BODY_KB * 1024,
});

async function start(): Promise<void> {
  await waitForPostgres();
  await runMigrations();

  // Global limit as a backstop. Individual routes set their own tighter ones.
  await app.register(rateLimit, {
    global: false,
    max: 120,
    timeWindow: '1 minute',
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true, ts: new Date().toISOString() };
  });

  // ── The public page ──────────────────────────────────────────────
  // A plain, self-contained page: the figures, a map of the cafes that asked
  // to be on it, and a straight account of what is and is not collected.
  // Anyone who finds this host by accident should be able to understand what
  // it does without reading our code.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.resolve(here, '..', 'public');
  const leafletDir = path.resolve(here, '..', 'node_modules', 'leaflet', 'dist');

  await app.register(staticPlugin, {
    root: publicDir,
    prefix: '/',
    index: ['index.html'],
    // The page changes rarely, its data does not come from here.
    cacheControl: true,
    maxAge: '1h',
  });
  await app.register(staticPlugin, {
    root: leafletDir,
    prefix: '/vendor/leaflet/',
    decorateReply: false,
    cacheControl: true,
    // Immutable: the version is pinned in package.json.
    maxAge: '30d',
  });

  // Modest headers for a page that takes no input and sets no cookies. The
  // tile host is the only third party, and it only ever serves images.
  app.addHook('onSend', async (request, reply, payload) => {
    if (!request.raw.url?.startsWith('/api/')) {
      void reply.header(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "img-src 'self' data: https://*.basemaps.cartocdn.com",
          "style-src 'self'",
          "script-src 'self'",
          "connect-src 'self'",
          "frame-ancestors 'none'",
          "base-uri 'self'",
        ].join('; '),
      );
      void reply.header('X-Content-Type-Options', 'nosniff');
      void reply.header('Referrer-Policy', 'no-referrer');
    }
    return payload;
  });

  await app.register(pingRoutes);
  await app.register(publicStatsRoutes);
  await app.register(adminRoutes);

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`telemetry listening on ${env.HOST}:${env.PORT}`);
}

/** Compose starts us alongside Postgres, so the first connection may lose the race. */
async function waitForPostgres(): Promise<void> {
  const deadline = Date.now() + 60_000;
  let delayMs = 500;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, 5000);
    }
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app.close().then(() => pool.end()).then(() => process.exit(0));
  });
}

start().catch((err) => {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
});
