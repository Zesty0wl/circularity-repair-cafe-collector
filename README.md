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
plain account of what is and is not collected.

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
descriptions, notes, photos, or a raw IP address. The country comes from
Cloudflare's `CF-IPCountry` header, so no address is ever kept.

## The one thing to know before changing the queries

**Every number in a ping is a running total for the life of that install, not a
figure for the day.** So a worldwide total is a sum over *the newest ping per
install*:

```sql
WITH latest AS (
  SELECT DISTINCT ON (install_id) * FROM pings
  ORDER BY install_id, received_at DESC
)
SELECT SUM(repairs_fixed) FROM latest;
```

Summing the whole `pings` table multiplies every cafe by the number of days it
has been running. The answer looks entirely plausible and is wrong by a factor
of hundreds. This is the bug to watch for.

Sending totals rather than daily deltas is deliberate: a hub that is offline
for a week needs no outbox and no replay, because the next ping carries the
full picture.

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
| GET | `/health` | none | For the container healthcheck. |
| GET | `/` | none | The public page. Static files from `public/`, MapLibre from `node_modules`, map tiles from OpenFreeMap. |

`POST /api/v1/ping` answers `{ ok, token?, nextPingAfterHours }`. `token` appears
only on the call that mints it. `nextPingAfterHours` lets us slow every install
down later without shipping new client code.

## Running it

```bash
cp .env.example .env
# Both secrets: openssl rand -hex 24
docker compose up -d --build
curl -fsS http://127.0.0.1:5040/health
```

Host port **5040**, bound to loopback only. nginx on this box is what faces the
internet, the same arrangement as the hub on 5026.

### Putting it on the internet

```bash
sudo cp nginx/repaircafetelemetry.bzwrd.co.uk.conf \
        /etc/nginx/sites-available/repaircafetelemetry.bzwrd.co.uk
sudo ln -s /etc/nginx/sites-available/repaircafetelemetry.bzwrd.co.uk \
           /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Then one **proxied** A record for `repaircafetelemetry.bzwrd.co.uk` pointing at
this host. The certificate is the Cloudflare origin certificate for
`*.bzwrd.co.uk`, already on the box. Keeping Cloudflare's proxy on is not
optional: `CF-IPCountry` is where the country comes from.

## Checking on it

```bash
docker compose logs -f app
curl -s http://127.0.0.1:5040/api/v1/public/summary | jq
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
     http://127.0.0.1:5040/api/v1/admin/overview | jq
```

## Backups

One volume, `repair-cafe-telemetry-db`:

```bash
docker exec repair-cafe-telemetry-db pg_dump -U telemetry telemetry \
  | gzip > telemetry-$(date +%F).sql.gz
```

## Layout

```
src/
  index.ts              start-up, health, rate limiting
  env.ts                settings, validated at boot
  db/schema.ts          installs, pings
  db/migrate.ts         idempotent DDL, same approach as the hub
  lib/payload.ts        what a hub may send, and nothing else
  lib/tokens.ts         issue, hash, compare; country from Cloudflare
  routes/ping.ts        ingest and forget
  routes/publicStats.ts summary and map
  routes/admin.ts       the view for us
services/directory.ts a mirror of the public repaircafe.org directory, so a
                      cafe's slug becomes a pin without us storing a location
public/               the public page: index.html, styles.css, app.js
nginx/                  the vhost to install on the host
```

MIT, like the hub. See [LICENSE](./LICENSE) and [CHANGELOG.md](./CHANGELOG.md).
