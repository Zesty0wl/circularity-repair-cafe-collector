# Repair Cafe Hub telemetry

Collects anonymous usage counts from
[Circularity Repair Cafe Hub](https://github.com/Zesty0wl/circularity-repair-cafe-hub)
installs that chose to share them, and publishes the totals.

**This is the receiving half of a pair.** The sending half lives in the hub, at
`apps/server/src/services/telemetry.ts`, and the reasoning behind both is in
[`docs/proposal-telemetry.md`](https://github.com/Zesty0wl/circularity-repair-cafe-hub/blob/main/docs/proposal-telemetry.md)
there. A change to the payload has to be made in both places, and the
`schemaVersion` field exists so an older hub and a newer collector can tell.

Running at <https://repaircafetelemetry.bzwrd.co.uk>, which also serves the
public page: the figures, a map of the cafes that asked to be on it, and a
plain account of what is and is not collected. It is a Cloudflare Worker with
a D1 database, in the Neil Johnson account, the same shape as the hub's own
Worker edition. It used to be Docker on nostromo; see
[`docs/plan-cloudflare-worker.md`](docs/plan-cloudflare-worker.md).

## What it holds, and what it refuses to

A hub sends one small JSON body a day. Every field is a count, a date, a
version or a flag. There is **no free text anywhere**, on purpose, because free
text is where personal data hides. Anything not named in the schema is dropped
before the body is stored, so a hub cannot send us something we did not ask
for even by accident.

Two levels, chosen by the cafe during its own setup:

| | **Standard** | **Community** |
|---|---|---|
| Counts | yes | yes |
| Cafe name and location | **no** | yes, to appear on the public map |

A ping that claims Standard but carries cafe details has them thrown away here
rather than trusted, so a client bug cannot put somebody on a public map.

Never received or stored: names of people, anything about a visitor, item
descriptions, notes, photos, or a raw IP address. A Community cafe's country
comes from its own repaircafe.org listing, under the same rule as its pin (see
`placeFromListing()` in `services/directory.ts`). Other installs have none:
where a ping came from says nothing, because hubs are Workers and their
requests leave from any Cloudflare data centre. The hourly rate
limits are counted in a Durable Object named by a keyed hash of the address,
and wiped an hour after the last request.

## The one thing to know before changing the queries

**Every number in a ping is a running total for the life of that install, not a
figure for the day.** So a worldwide total is a sum over *the newest ping per
install*:

```sql
WITH latest AS (
  SELECT * FROM (
    SELECT p.*, ROW_NUMBER() OVER (PARTITION BY install_id ORDER BY received_at DESC) AS rn
    FROM pings p
  ) WHERE rn = 1
)
SELECT SUM(repairs_fixed) FROM latest;
```

Summing the whole `pings` table multiplies every cafe by the number of days it
has been running. The answer looks entirely plausible and is wrong by a factor
of hundreds. This is the bug to watch for.

Sending totals rather than daily deltas is deliberate: a hub that is offline
for a week needs no outbox and no replay, because the next ping carries the
full picture.

The public figures go one step further and do not read `pings` at all: they
sum the `verified_*` columns on `installs`, which hold what we fetched from
each cafe's own site. See
[`docs/proposal-verified-telemetry.md`](docs/proposal-verified-telemetry.md).

The map follows the same rule. It shows the name the cafe's site served at its
last check (`verified_name`), a link to the host we verified, and a pin from the
cafe's own repaircafe.org listing. Nothing a ping says reaches the map, because
pings arrive between checks and can say anything.

**Who owns an install.** A hub's install id is public: its site shows it, so we
can check the hub is real. From hub 1.13.2 a hub also makes a claim secret,
sends it with its pings, and publishes only its hash. A site whose hash does not
match the install's never passes the check, and the real hub can take its id
back with its secret. See `src/routes/ping.ts` and `src/services/verify.ts`.

## API

| Method | Path | Auth | What |
|---|---|---|---|
| POST | `/api/v1/ping` | token, after the first | Ingest. The first call has no token and is given one. |
| POST | `/api/v1/forget` | token | Delete this install and every ping it sent. |
| GET | `/api/v1/public/summary` | none | Worldwide totals. Cached 5 minutes. |
| GET | `/api/v1/public/map` | none | Cafes that chose to be on the map. |
| GET | `/api/v1/admin/overview` | `ADMIN_TOKEN` | Versions, activity, new installs per week. |
| GET | `/api/v1/admin/installs` | `ADMIN_TOKEN` | Who is out there, newest first. |
| POST | `/api/v1/admin/installs/:id/block` | `ADMIN_TOKEN` | Silence a noisy install without a deploy. |
| GET | `/health` | none | For monitoring. Touches the database. |
| GET | `/` | none | The public page, served as static assets: `public/` and MapLibre, map tiles from OpenFreeMap. |

`POST /api/v1/ping` answers `{ ok, token?, nextPingAfterHours }`. `token` appears
only on the call that mints it. `nextPingAfterHours` lets us slow every install
down later without shipping new client code.

## Running it

```bash
npm install
npm test            # builds the assets, then runs every test inside workerd
npm run dev         # wrangler dev on http://localhost:8787, with a local D1
```

`wrangler dev` reads secrets from `.dev.vars`, which git ignores:

```
ADMIN_TOKEN=a-long-random-string
LIMIT_SECRET=another-long-random-string
```

Give the local database its tables with
`npx wrangler d1 migrations apply repair-cafe-telemetry --local`.

## Deploying

Wrangler needs a token for the Neil Johnson account in
`CLOUDFLARE_API_TOKEN`, and the account id in `CLOUDFLARE_ACCOUNT_ID`.

```bash
npm run db:migrate   # only when migrations/ has something new
npm run deploy       # builds dist/assets, uploads the Worker and the page
```

Secrets are set once and survive deploys:

```bash
openssl rand -hex 32 | npx wrangler secret put ADMIN_TOKEN
openssl rand -hex 32 | npx wrangler secret put LIMIT_SECRET
```

The hostname is a **custom domain** on the Worker, not a DNS record pointing
somewhere. The daily cron (04:17 UTC) refreshes the repaircafe.org directory.

## Checking on it

```bash
npx wrangler tail repair-cafe-telemetry
curl -s https://repaircafetelemetry.bzwrd.co.uk/api/v1/public/summary | jq
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
     https://repaircafetelemetry.bzwrd.co.uk/api/v1/admin/overview | jq
```

Logs are also in the dashboard, under the Worker's Observability tab.

## Backups

D1 keeps 30 days of history and can be put back to any minute of it:

```bash
npx wrangler d1 time-travel restore repair-cafe-telemetry --timestamp 2026-10-21T18:00:00Z
```

For a copy to keep: `npx wrangler d1 export repair-cafe-telemetry --remote --output telemetry-$(date +%F).sql`.

## Layout

```
src/
  worker.ts             the entry point: fetch, and the daily cron
  app.ts                routing, the API-wide rate limit, errors
  env.ts                bindings, secrets and settings
  limiter.ts            hourly limits per address, in a Durable Object
  db/schema.ts          installs, pings, directory (drizzle, matching migrations/)
  lib/payload.ts        what a hub may send, and nothing else
  lib/tokens.ts         issue, hash, compare
  lib/country.ts        two-letter codes from the country in a listing address
  lib/http.ts           JSON answers and reading a body with a ceiling
  routes/ping.ts        ingest and forget
  routes/publicStats.ts summary and map
  routes/admin.ts       the view for us
  services/verify.ts    fetching a cafe's own site to prove it is real
  services/directory.ts a copy of the public repaircafe.org directory, so a
                        cafe's slug becomes a pin without us storing a location
migrations/             D1 schema, applied with wrangler
public/                 the public page: index.html, styles.css, app.js, _headers
scripts/
  build-assets.mjs      public/ and MapLibre into dist/assets, version stamped
  export-postgres.mjs   the Docker edition's data into D1 (used once, at the move)
  export-directory.mjs  its cached directory into D1 (likewise)
test/                   vitest in workerd, against the real wrangler.jsonc
```

The Docker edition (`Dockerfile`, `docker-compose.yml`, `nginx/`,
`scripts/install-nginx.sh`) stays until it has been switched off for good.

MIT, like the hub. See [LICENSE](./LICENSE) and [CHANGELOG.md](./CHANGELOG.md).
