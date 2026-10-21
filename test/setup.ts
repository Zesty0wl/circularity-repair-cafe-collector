import { applyD1Migrations, env } from 'cloudflare:test';

// Every test file starts from the same schema as production.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
