# Changelog

Notable changes to the Repair Cafe Hub telemetry collector. Newest first.

## 1.1.0 — 27 July 2026

### Added

- A public page at `/` instead of a paragraph of plain text: the headline
  figures, a map of the cafes that asked to be on it, and a straight account of
  what is and is not collected. No fonts or scripts are fetched from anywhere
  else, so it loads on a phone in a hall with two bars of signal.
- Pins are looked up from a mirror of the public repaircafe.org directory. A
  cafe on that directory sends us its slug and nothing else, so appearing on
  the map costs it no location data at all. A cafe not listed there can send
  rounded coordinates instead, and those win where present.
- Content-Security-Policy, nosniff and no-referrer on the page. The tile host
  is the only third party and it only ever serves images.

### Fixed

- The map endpoint returned cafes with `lat: null` and drew nothing. It was
  always meant to resolve a slug through the directory, and never did.

## 1.0.0 — 27 July 2026

First working version. Receives daily summaries from
[Repair Cafe Hub](https://github.com/Zesty0wl/circularity-repair-cafe-hub)
installs that have chosen to share them, and publishes the totals.

### Added

- `POST /api/v1/ping` takes one summary per install per day. The first call
  needs no token and is given one; every call after that must present it.
- `POST /api/v1/forget` deletes an install and every ping it ever sent. A cafe
  that asks to be forgotten should never have to ask twice.
- `GET /api/v1/public/summary` adds up what the community has done, and says
  plainly that cafes which chose not to share are invisible, so the figures are
  a floor rather than a count.
- `GET /api/v1/public/map` lists the cafes that asked to be on the map, with
  their figures. A cafe listed on repaircafe.org sends only its slug, so we hold
  no location of our own.
- `GET /api/v1/admin/*` for us: which versions are out there, how many installs
  are active, how many arrived each week, and a switch to silence a noisy one
  without a deploy.
- A plain-English page at `/` explaining what this is and how to stop sending,
  for anyone who finds the host by accident.
- `scripts/install-nginx.sh` installs the vhost, checks the backend is healthy
  first, tests the configuration, and rolls the whole thing back rather than
  reloading a broken config.

### How it refuses to hold personal data

- The payload schema has no free text field anywhere. Anything not named in it
  is dropped before the body is stored, so a hub cannot send us something we
  did not ask for even by accident.
- A ping that claims the Standard level but carries cafe details has them
  thrown away rather than trusted, so a client bug cannot put somebody on a
  public map.
- The country comes from Cloudflare's `CF-IPCountry` header, so no address is
  ever stored. Addresses are used for rate limiting and then forgotten, and are
  redacted from the logs.

### Notes for anyone running this

- Every number in a ping is a running total for the life of that install, so
  worldwide figures must be summed over **the newest ping per install**.
  Summing the whole `pings` table multiplies each cafe by the number of days it
  has been running, and the answer looks entirely plausible. See the README.
- Two containers: the app and its own Postgres, on the default bridge network.
  Host port 5040, bound to loopback, with nginx in front.
