# Changelog

Notable changes to the Repair Cafe Hub telemetry collector. Newest first.

## 2.0.0 — 27 July 2026

**The published figures now mean something different.** They count only cafés
whose own site we fetched and checked, so they are smaller and defensible
rather than larger and unverifiable. See `docs/proposal-verified-telemetry.md`.

### Added

- **Verification.** After a ping, the collector fetches
  `https://<that café's site>/api/public/telemetry` and looks for the same
  install id it was just sent. Only a hub genuinely running at that address can
  answer, which is the ACME HTTP-01 idea. It does not make faking impossible: it
  makes one fake café cost a domain, a certificate and a served endpoint, each
  time, instead of one `curl`.
- **The figures we publish are the ones we fetched**, not the ones we were
  handed. Pushed numbers are kept in `pings` as history and never shown as fact.
- `reportedInstalls` in the summary: cafés we heard from but could not check.
  Counted and stated, never folded into the impact figures.
- A café is placed on the map by its own coordinates, or by its repaircafe.org
  listing **only when the website that listing names is the host we verified**.
  Otherwise a café could prove it controls its own domain and then borrow
  somebody else's address.

### Security

Fetching a URL a stranger supplied is server-side request forgery, and from
this container the Docker host's other services are reachable. The guards, all
tested: https only; a bare IP is refused; the name is resolved and every
address checked against loopback, RFC1918 (including the Docker bridge),
link-local, cloud metadata, CGNAT, multicast and IPv6 ULA; no redirects; a
fixed path that never comes from the payload; 5s timeout; 64 KB ceiling; and
the fetched body is never returned to the sender.

Verified against the live service: a ping claiming 9,000,000 repairs and
another café's slug is accepted, recorded, and reaches neither the figures nor
the map.

## 1.3.0 — 27 July 2026

Security. Everything here was found by probing the running service rather than
reading the code, and every finding was reproduced before it was fixed.

### Fixed

- **A stranger could appear on the public map as any café in the repaircafe.org
  directory.** The slug arrived in the payload and nothing proved it belonged to
  the sender, but it was then resolved against the directory mirror to fetch
  that café's real name and coordinates. So a fabricated install could be drawn
  at a real café's address, under its real name, with numbers of its choosing.
  The lookup is gone: a café now appears only if it sent its own coordinates,
  under the name it sent. The map may be empty until verification ships, which
  is the right trade. See `docs/proposal-verified-telemetry.md`.
- **A malformed admin token returned 500 rather than 401.** The comparison
  padded the raw strings to 64 characters, so a multi-byte token produced
  buffers of different byte lengths and `timingSafeEqual` threw. It now compares
  two sha256 digests, which are always the same length whatever was sent.
- **The admin endpoints had no rate limit at all.** 60 wrong tokens got 60
  answers. Now 30 a minute.
- **One address could create 30 new installs an hour.** The route's limit was
  written for returning pings and applied to first contact as well. Registering
  a new install is now limited separately, to three an hour, because setting up
  a café is something you do once.

### Known, and not yet fixed

- The public figures still count anything that was pushed. Twelve requests from
  one laptop moved them from 12 repairs at 1 café to 24 at 13. Verification is
  the fix and is specified in `docs/proposal-verified-telemetry.md`.
- The origin answers on its own IP, so Cloudflare can be bypassed and
  `X-Forwarded-For` is attacker-controlled, which makes per-address limits
  best-effort rather than reliable. That is an nginx change on the host and
  affects every site on it, not only this one.
- Pings are still kept forever.

## 1.2.0 — 27 July 2026

### Changed

- Rebuilt the layout of the public page. One hero figure leads, six supporting
  tiles fill a grid without stranding one on a row of its own, and the map sits
  beside the list of cafés rather than above it. Every section now lines up on
  one left edge.

### Fixed

- The page had no vertical spacing at all: every band ran into the next. Both
  `.wrap` and `.section` were on the same element, and `.wrap { padding: 0 20px }`
  beat `section { padding: 44px 0 }` on specificity, so the vertical padding was
  silently discarded. The two now do one job each and are never combined.
- A dropped database connection killed the process. node-postgres emits `error`
  on the pool when an idle connection dies, and an unhandled `error` event ends
  Node, so a database restart took the collector down and left it down. Losing a
  connection is normal and is now logged and recovered from.
- Stylesheet and script URLs carry a hash of their own contents. They were
  versioned from `package.json`, which meant changing a stylesheet without
  bumping the version left the URL identical, Cloudflare went on serving the old
  file against new markup, and the page looked broken with nothing in the
  container to explain it. A content hash cannot be forgotten about.

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
