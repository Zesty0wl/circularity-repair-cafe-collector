# Plan: move the collector from Docker to a Cloudflare Worker

**Status:** built and staged on workers.dev; cutover not yet done
**Written:** 21 October 2026

## Where it is now

One Fastify process and one Postgres container in Docker Compose on nostromo,
in `~/docker/circularity/repair-cafe-telemetry`. nginx terminates TLS with the
Cloudflare origin certificate and proxies `127.0.0.1:5040`. Cloudflare sits in
front as a proxy and nothing more.

That is a whole server to keep patched for a service that, on 21 October 2026,
held **4 installs and 114 pings** (8 MB of database, most of it Postgres
overhead) and gets one ping per café per day.

The hub already runs on Workers with D1 and drizzle
(`circularity-repair-cafe-hub/apps/cloudflare`). The collector should look
like it, so that there is one way of doing things rather than two.

## What must not change

- **The hostname.** Every hub in the wild sends to
  `https://repaircafetelemetry.bzwrd.co.uk` unless overridden
  (`apps/cloudflare/src/env.ts:71` in the hub), and the hub's world page links
  to it. It stays.
- **Install tokens.** Only their hashes are stored, so the hashes move with the
  data and every hub carries on with the token it already has. No hub notices.
- **The API.** `/api/v1/ping`, `/api/v1/forget`, `/api/v1/public/*`,
  `/api/v1/admin/*` and `/health` keep their paths, bodies and status codes.
- **What we never keep.** No addresses in the database or the logs. Country
  still comes from Cloudflare, now from `request.cf.country` rather than a
  header nginx passed along.
- **Published figures are the ones we fetched**, never the ones we were sent.

## The shape of it

One Worker in this repo, replacing `src/`, with:

| Piece | Now | On Workers |
|---|---|---|
| HTTP | Fastify | A plain `fetch` handler and a small router, as the hub does |
| Database | Postgres 16 | **D1**, schema through drizzle's `sqlite-core` |
| Migrations | DDL run on boot | `migrations/0001_init.sql`, applied with `wrangler d1 migrations apply` |
| Public page | Served by hand to stamp `__V__` | **Static assets**. A build step copies `public/` and MapLibre's three files and stamps the hash |
| Security headers | `onSend` hook | `_headers` file for the page and assets, set in code for the API |
| Summary cache | In-process, 5 minutes | Cache API, 5 minutes |
| repaircafe.org directory | JSON file on a volume | A `directory` table in D1, refreshed by a **daily Cron Trigger** |
| Background verification | `void verifyIfDue(...)` | `ctx.waitUntil(verifyIfDue(...))` |
| Per-minute limits | `@fastify/rate-limit` | **Rate Limiting binding** (it only counts in 10 s or 60 s windows) |
| Hourly limits | In-process maps | **One Durable Object**, keyed by a keyed hash of the address |
| `ADMIN_TOKEN` | `.env` | `wrangler secret put ADMIN_TOKEN` |
| Logs | pino, with redaction | Workers Logs (`observability.enabled`), and no address ever logged |

### Database: D1, not Postgres via Hyperdrive

Hyperdrive would let the Worker keep talking to Postgres, but Postgres would
still be a container on nostromo, which is the thing we are trying to stop
running. D1 is plenty for a table of a few hundred cafés.

What changes in the SQL:

- `UUID` becomes `TEXT`, `JSONB` becomes `TEXT`, `NUMERIC` becomes `REAL`.
  `BIGSERIAL` becomes `INTEGER PRIMARY KEY AUTOINCREMENT`.
- Timestamps become integer milliseconds (drizzle's `timestamp_ms`).
  `NOW() - INTERVAL '45 days'` becomes `unixepoch('now', '-45 days') * 1000`.
- The admin query's `DISTINCT ON (install_id)` becomes `ROW_NUMBER() OVER
  (PARTITION BY install_id ORDER BY received_at DESC) = 1`. The public
  figures already read from `installs`, so they need no rewrite.
- `COUNT(*) FILTER (WHERE ...)` works in D1 as it is.
  `date_trunc('week', ...)` becomes `strftime`.
- `ON DELETE CASCADE` on `pings` still does the work for `/forget`, because D1
  enforces foreign keys.
- A ping is an insert plus an update, and they go in one `db.batch()` so they
  happen together or not at all.

### Verification gets safer, not just ported

Today's worst risk is that verification runs **inside Docker on nostromo**, so
a café's `publicUrl` can point at `172.17.0.1` and probe the host. That is why
`verify.ts` resolves DNS itself and checks every address. A Worker has no
private network to reach: its `fetch` goes out over Cloudflare's network.

- Keep the rules: https only, no bare IP hosts, a fixed path, a 5 second
  timeout, a 64 KB cap, and the body never reaching the caller.
- Redirects: use `redirect: 'manual'` and treat any 3xx as a failure, which
  matches today's `redirect: 'error'`.
- Drop `node:dns` and `node:net`. Neither exists in Workers, and the threat
  they guarded against goes with the Docker host.
- Add the **`global_fetch_strictly_public`** compatibility flag. It makes every
  fetch go out over the public internet, even to our own zones. A hub on a
  `workers.dev` address in the same account can then be verified, instead of
  failing with error 1042.
- The 30-checks-a-minute ceiling becomes a Rate Limiting binding with a fixed
  key.

### Rate limits

| Limit | How |
|---|---|
| 120 a minute per address (backstop) | Rate Limiting binding |
| Admin 30 a minute | Rate Limiting binding |
| Outbound checks 30 a minute, overall | Rate Limiting binding, one key |
| Ping 30 an hour per address | Durable Object |
| New installs 3 an hour per address | Durable Object |
| Forget 10 an hour per address | Durable Object |

An hour is longer than the Rate Limiting binding can count, and longer than a
Durable Object keeps anything in memory. An idle one is evicted within
minutes, and an attacker who paused between tries would reset the count. So
the Durable Object keeps timestamps in its own SQLite storage, keyed by
`HMAC(secret, address)`, and an alarm deletes them when the hour is up. No
address is stored, and nothing that identifies one outlives the window.

### The public page

- **Build step** (`scripts/build-assets.mjs`): copy `public/`, plus
  `maplibre-gl.mjs`, `maplibre-gl-worker.mjs` and `maplibre-gl.css`, into
  `dist/assets/`. Then replace `__V__` with a hash of the contents.
- **`_headers`**:
  - the same CSP as today;
  - `nosniff` and `no-referrer`;
  - `no-cache` on `/`;
  - a long `max-age` on everything else.
- **Asset serving**: by the Workers static-assets binding. Only `/api/*` and
  `/health` run the Worker (`run_worker_first`), so a page view costs no
  Worker invocation.

## Order of work

1. **Scaffold.** On a branch: `wrangler.jsonc`, the D1 schema and its first
   migration, the router and `/health`. Leave the Docker files in place until
   the cutover.
2. **Port.**
   - Do `payload.ts` and `tokens.ts` first; with `nodejs_compat` they are
     almost unchanged.
   - Then `ping`, `forget`, `admin` and `publicStats`.
   - Then `verify` and `directory`.
   - Then the cron.
3. **Tests**, with `@cloudflare/vitest-pool-workers` as the hub does. There are
   none today, and a rewrite is the moment it matters. They should cover:
   - first contact issues a token, and a returning ping without one is
     refused;
   - a wrong token, clock skew and a blocked install;
   - forget cascades to pings;
   - admin authentication;
   - the summary counts only verified, active, unblocked installs;
   - verify refuses http, a bare IP, a redirect, an oversize body and a
     mismatched `installId`;
   - the hourly limits survive the Durable Object being evicted.
4. **Stage on `workers.dev`.** Point one test hub's `TELEMETRY_ENDPOINT`
   override at the `workers.dev` URL and watch a real ping. Check it is
   verified and appears on the map.
5. **Export script** (`scripts/export-postgres.mjs`). It reads Postgres on
   nostromo and writes `INSERT`s for D1, converting timestamps, numerics and
   JSON. Run it against a copy first, and compare row counts and the summary
   output side by side.
6. **Cutover**, about ten minutes:
   1. Stop the app container. Leave Postgres running.
   2. Export, then `wrangler d1 execute --remote --file`.
   3. Attach `repaircafetelemetry.bzwrd.co.uk` to the Worker as a **custom
      domain**. Cloudflare replaces the proxied A record itself.
   4. Check `/health`, the summary, the map and one ping.

   Pings that fail during the gap need no recovery. Every figure is a running
   total, so a hub that misses one simply catches up with its next ping.
7. **Rollback**, if needed: detach the custom domain, restore the A record,
   start the container. Pings received by D1 meanwhile are not copied back,
   and they don't need to be, for the same reason.
8. **Decommission** after two quiet weeks:
   - `pg_dump` to keep;
   - `docker compose down`;
   - remove the nginx vhost;
   - delete `Dockerfile`, `docker-compose.yml`, `nginx/` and
     `scripts/install-nginx.sh`;
   - rewrite the README's running and deploying sections.

## Where it stands

Built on the `cloudflare-worker` branch, 21 October 2026:

- **Tests.** 51 run inside workerd against the real `wrangler.jsonc`, covering
  every point in step 3 above.
- **Staging.** The Worker is deployed at
  <https://repair-cafe-telemetry.jonnokid.workers.dev>, with D1
  `repair-cafe-telemetry` (WEUR) and both secrets set. `ADMIN_TOKEN` was
  copied from nostromo's `.env`, so the admin token in use today works
  unchanged.
- **Copied data.** Production's data and its cached directory, copied that
  afternoon, give a summary and map identical to the live site's.
- **End to end.** A made-up install pinged the staged Worker claiming
  `https://repaircafe.circularity.org`:
  - its country came through as GB;
  - Cloudflare fetched that real hub and refused the claim ("that site
    belongs to a different install");
  - forget then removed it and its ping.
- **repaircafe.org was down** all that day ("Site Currently Unavailable").
  That is why `scripts/export-directory.mjs` exists: the map keeps its pins
  from nostromo's cached copy until the cron can fetch a fresh one.

## Cutover, step by step

The data has to be copied again at cutover, because hubs keep pinging the
Docker edition until then. With `S` a scratch folder outside the repo, and
wrangler given the Neil Johnson token:

```bash
# 1. Copy the cached directory while the app container is still running.
#    Pings do not change it.
ssh nostromo 'docker exec repair-cafe-telemetry cat /data/repair-cafe-directory.json' \
  | node scripts/export-directory.mjs > $S/directory.sql
npx wrangler d1 execute repair-cafe-telemetry --remote --file $S/directory.sql -y

# 2. Stop taking pings on the old side, then copy the data across. The file
#    replaces what D1 holds. Postgres stays up.
ssh nostromo 'cd ~/docker/circularity/repair-cafe-telemetry && docker compose stop app'
ssh nostromo "docker exec repair-cafe-telemetry-db psql -U telemetry -d telemetry -At -c \"
  SELECT json_build_object(
    'installs', (SELECT COALESCE(json_agg(i), '[]') FROM installs i),
    'pings',    (SELECT COALESCE(json_agg(p ORDER BY p.id), '[]') FROM pings p))\"" \
  | node scripts/export-postgres.mjs > $S/export.sql
npx wrangler d1 execute repair-cafe-telemetry --remote --file $S/export.sql -y

# 3. Attach the hostname. Cloudflare swaps the proxied A record for the Worker.
#    Add to wrangler.jsonc, then deploy:
#      "routes": [{ "pattern": "repaircafetelemetry.bzwrd.co.uk", "custom_domain": true }]
#    If the existing A record blocks it, delete that record and deploy again.
npx wrangler deploy

# 4. Check: /health, the summary and map against the counts copied in step 2,
#    the page in a browser, and the next real ping in `wrangler tail`.
```

Then merge `cloudflare-worker` into `main`. The checkout on nostromo stays on
the old commit and its image stays built, so rolling back is: remove the
custom domain, put the A record back pointing at nostromo, and run
`docker compose start app`.

## Settled

- **Account:** Neil Johnson, which also holds the `bzwrd.co.uk` zone, so the
  custom domain can attach directly.
- **Token:** an account API token for that account, kept outside the repo.
  Checked on 21 October 2026: it can read Workers scripts, D1, R2 and the zone.
- **Plan size:** not yet settled. Build for Workers Free's 10 ms of CPU per
  request, and let the tests show whether that holds.
