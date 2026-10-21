-- The collector's tables in D1. src/db/schema.ts describes the same thing to
-- drizzle, and the two must agree.
--
-- Times are milliseconds since 1970. UUIDs are text. What Postgres held as
-- NUMERIC is REAL here: coordinates to two places and kilograms of CO2 lose
-- nothing that matters.

CREATE TABLE installs (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  app_version TEXT,
  level TEXT NOT NULL DEFAULT 'standard',
  country TEXT,
  cafe_slug TEXT,
  cafe_name TEXT,
  cafe_url TEXT,
  cafe_lat REAL,
  cafe_lng REAL,
  is_blocked INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER,
  verified_host TEXT,
  verify_checked_at INTEGER,
  verify_error TEXT,
  verified_repairs_recorded INTEGER,
  verified_repairs_fixed INTEGER,
  verified_repairs_not_fixed INTEGER,
  verified_sessions_held INTEGER,
  verified_volunteers INTEGER,
  verified_co2_saved_kg REAL
);
CREATE INDEX idx_installs_last_seen_at ON installs(last_seen_at);
CREATE INDEX idx_installs_verified_at ON installs(verified_at);
CREATE INDEX idx_installs_level ON installs(level);

CREATE TABLE pings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  install_id TEXT NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
  received_at INTEGER NOT NULL,
  sent_at INTEGER,
  app_version TEXT,
  payload TEXT NOT NULL,
  sessions_held INTEGER,
  volunteers INTEGER,
  repairs_recorded INTEGER,
  repairs_fixed INTEGER,
  repairs_not_fixed INTEGER,
  co2_saved_kg REAL
);
CREATE INDEX idx_pings_install_id ON pings(install_id);
CREATE INDEX idx_pings_received_at ON pings(received_at);
CREATE INDEX idx_pings_install_received ON pings(install_id, received_at DESC);

CREATE TABLE directory (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  country TEXT,
  website TEXT
);
