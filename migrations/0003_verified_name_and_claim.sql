-- What the map shows about a cafe now comes only from its own site, never
-- from a ping. verified_name is the name its site served at the last check.
-- Until the next check, it starts as the name shown today.
ALTER TABLE installs ADD COLUMN verified_name TEXT;
UPDATE installs SET verified_name = cafe_name WHERE verified_at IS NOT NULL;

-- A hub makes its own claim secret, sends it with its pings, and publishes
-- only its hash on /api/public/telemetry. We keep the hash of what we were
-- sent. A site that publishes a different hash belongs to another install, so
-- a stranger who claims a hub's id first can never pass the check.
ALTER TABLE installs ADD COLUMN claim_hash TEXT;
