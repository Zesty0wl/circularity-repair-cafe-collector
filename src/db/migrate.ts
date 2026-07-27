import { pool } from './index.js';

/**
 * Idempotent migration runner, the same approach as the hub: no migration
 * tool at runtime, just DDL we can read, every statement safe to run again.
 */
const STATEMENTS: string[] = [
  'CREATE EXTENSION IF NOT EXISTS "pgcrypto"',

  `CREATE TABLE IF NOT EXISTS installs (
    id UUID PRIMARY KEY,
    token_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    app_version TEXT,
    level TEXT NOT NULL DEFAULT 'standard',
    country TEXT,
    cafe_slug TEXT,
    cafe_name TEXT,
    cafe_url TEXT,
    cafe_lat NUMERIC(6,2),
    cafe_lng NUMERIC(6,2),
    is_blocked BOOLEAN NOT NULL DEFAULT FALSE
  )`,
  'CREATE INDEX IF NOT EXISTS idx_installs_last_seen_at ON installs(last_seen_at)',
  'CREATE INDEX IF NOT EXISTS idx_installs_level ON installs(level)',

  `CREATE TABLE IF NOT EXISTS pings (
    id BIGSERIAL PRIMARY KEY,
    install_id UUID NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    app_version TEXT,
    payload JSONB NOT NULL,
    sessions_held INT,
    volunteers INT,
    repairs_recorded INT,
    repairs_fixed INT,
    repairs_not_fixed INT,
    co2_saved_kg NUMERIC(12,3)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_pings_install_id ON pings(install_id)',
  'CREATE INDEX IF NOT EXISTS idx_pings_received_at ON pings(received_at)',
  // The public summary asks for "the newest ping for each install" on every
  // cache miss. This is the index that makes that a cheap question.
  'CREATE INDEX IF NOT EXISTS idx_pings_install_received ON pings(install_id, received_at DESC)',
];

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
  } finally {
    client.release();
  }
}
