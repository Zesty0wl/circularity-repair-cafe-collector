-- Every country so far came from where the ping was sent from. Hubs run as
-- Cloudflare Workers, so that was a Cloudflare data centre, not the cafe: one
-- cafe in England was recorded as Brazil. Forget them all. Each Community cafe
-- gets its country back from its own repaircafe.org listing at its next check.
UPDATE installs SET country = NULL;
