import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// The tests run inside workerd, the real Workers runtime, against the real
// wrangler.jsonc: a local D1 database, the Limiter Durable Object and the
// rate limiting bindings. test/setup.ts applies migrations/ before each file.
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      main: './src/worker.ts',
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          ADMIN_TOKEN: 'test-admin-token-0123456789abcdef',
          LIMIT_SECRET: 'test-limit-secret',
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
    testTimeout: 30_000,
    // The files share one local database, so they run one at a time.
    fileParallelism: false,
  },
}));
