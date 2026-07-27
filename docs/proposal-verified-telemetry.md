# Proposal: prove it, rather than believe it

**Status:** proposal, being built the same day
**Written:** 27 July 2026
**Follows:** [`docs/proposal-telemetry.md`](https://github.com/Zesty0wl/circularity-repair-cafe-hub/blob/main/docs/proposal-telemetry.md)
in the hub, which is the design this corrects.

## The problem

The collector believes whatever it is told. That was fine as a way to get data
flowing and is not fine now, for two reasons found by testing the live service.

**Anyone can invent our impact figures.** Twelve `curl` commands from one laptop
moved the public page from 12 repairs at 1 café to 24 at 13. The schema accepts
100,000,000 per field, so one request can claim ten million repairs, and nothing
afterwards distinguishes it from a real café. This matters more than ordinary
API abuse because the figures **are** the product: the moment they appear in a
funding application they need to be defensible, and today they are not.

**Anyone can appear on the map as somebody else.** `cafeDetailsFor` takes
`repaircafeSlug` straight from the payload, and `publicStats` then resolves it
against the repaircafe.org mirror to get that café's real name and coordinates.
So a stranger can send `repaircafeSlug: "some-other-cafe"` with numbers of their
choosing and be drawn on our map, at that café's real address, under its real
name. Nobody has. It is still an impersonation hole in shipped code.

Both come from the same mistake: treating data that merely *arrived* as if it
had been *authenticated*.

## Why the obvious fixes are not enough

Rate limits, ageing rules and "only count an install after 14 days" all raise
the cost of poisoning without changing its nature. They are also defeated on
this deployment, because the origin answers on its own IP: `X-Forwarded-For` is
attacker-controlled, so per-address limits are decorative. Those limits are
worth having. They are not an answer.

Reading round what other projects do was more useful than inventing something:

- **Debian popularity-contest** is our exact architecture: a weekly push, each
  host a random UUID. It is also the cautionary tale. Participation is 1–10% and
  it is widely described as gameable. Debian lives with that because popcon
  answers a *relative* question, which package is more used than another, where
  noise barely matters. It never publishes an absolute claim.
- **The Fediverse** does the opposite. Every Mastodon server exposes
  `/nodeinfo/2.0` with its own statistics and aggregators **pull** it. Faking
  that means running a real server on a real domain with a valid certificate.
- **joinmastodon.org** goes further again and lists only servers that signed a
  covenant: a curated list, reviewed by people.

We built popcon's architecture and made joinmastodon's promise.

## What we should do instead

Do not trust any URL to be a hub. Make the hub **prove it controls one**.

This is the ACME HTTP-01 pattern. The hub already generates an `installId` that
nothing else knows. If it also serves that id at a fixed public path, then:

```
push    installId = 362d1368-…   publicUrl = https://repaircafe.circularity.org
fetch   GET https://repaircafe.circularity.org/api/public/telemetry
reply   { "installId": "362d1368-…", "repairsFixed": 12, "sessionsHeld": 4, … }
```

Matching ids prove the thing that pushed controls that site. The counts come
back in the same response, so proof of control and cross-check of the numbers
are a single request.

Three properties make this the right shape:

1. **The URL being attacker-chosen stops mattering for correctness.** You can
   only ever verify a site you already control. That is the whole point.
2. **It needs nothing curated.** No allowlist, no approval queue, no human.
3. **The repaircafe.org directory leaves the trust chain entirely.** It was
   never able to authenticate anything: `external_link` is free text a café
   typed in years ago, which is why the hub has a `normaliseWebsite()` function
   full of repairs for missing schemes, `httsp://`, and entries that read
   "WhatsApp: …". It becomes what it should always have been, a convenience for
   placing a pin once identity is settled some other way.

### What it does not do

It does not make faking impossible. It makes one fake café cost a domain, a
certificate and a served endpoint, **per café**. A bored person will not. Some
determined person could. That is a real and large improvement over `curl`, and
overclaiming it would be its own kind of dishonesty.

## The danger this introduces

Reaching out to a URL a stranger supplied is server-side request forgery, and on
this host it is not theoretical. From inside the collector container:

```
172.17.0.1:5026  repair cafe hub      blocked    (bound to 127.0.0.1)
172.17.0.1:9000  portainer            blocked    (bound to 127.0.0.1)
172.17.0.1:8272  plausible            REACHABLE
172.17.0.1:5433  melcloud postgres    REACHABLE
```

Without care, `publicUrl: "http://172.17.0.1:5433"` turns the collector into a
probe against the Docker host. The rules, all of which are cheap:

| Rule | Why |
|---|---|
| HTTPS only | plain HTTP has no identity to prove |
| Resolve first, then check every address | a name can point anywhere |
| Reject loopback, RFC1918, link-local, CGNAT, IPv6 ULA, multicast | the internal network is not ours to scan |
| Connect to the checked address, carry the hostname in `Host` and SNI | closes the DNS-rebinding gap between check and connect |
| No redirects | a redirect is a second, unchecked URL |
| Fixed path only | never a path from the payload |
| 5s timeout, 64 KB cap | a slow or enormous reply is not our problem to hold |
| Never return the body to the caller | a blind probe teaches an attacker nothing |
| One verification attempt per install per day | this is outbound traffic to somebody else's server |

## Trust tiers

| | What it proves | Counts toward |
|---|---|---|
| **Verified** | serves our `installId` at its own https domain, and its own public numbers agree | the headline figures, and may be named on the map |
| **Reported** | pushed only: unreachable, unproven, or the numbers disagree | "installs exist", nothing else |

A café behind a home connection with no public address stays **Reported**
forever. That is a real exclusion and it must be said on the page rather than
hidden: the headline figures already carry "counts only the cafés that chose to
share", and this adds "and that we could check". Our own Raspberry Pi guide sets
up a Cloudflare Tunnel, so most installs following it will have a public address.

## Changes

### The hub

One new public route, `GET /api/public/telemetry`:

```json
{ "installId": "…", "repairsRecorded": 23, "repairsFixed": 12,
  "sessionsHeld": 4, "volunteers": 8, "co2SavedKg": 177.6 }
```

Returns `404` when the cafe has not agreed to share, so switching telemetry off
also stops answering the question. It exposes nothing that
`/api/public/stats` does not already, plus the install id, which identifies an
install to us and means nothing to anybody else.

### The collector

- `installs.verified_at`, `installs.verify_error`, `installs.public_url`.
- A `services/verify.ts` implementing the rules above.
- Verification attempted after a ping, at most daily, never blocking the reply.
- `/api/v1/public/summary` and `/api/v1/public/map` count **verified installs
  only**; the summary gains `reportedInstalls` so the difference is visible
  rather than quietly dropped.
- The map takes its name and pin from the verified site, never from a slug.

### While that is being built

The impersonation hole is live now, so the slug stops resolving to a directory
identity immediately, before any of the above lands. The map loses its only pin
until verification ships. An empty map that cannot lie is better than a
populated one that can, and the page already words the empty case properly.

## Decided against

- **A shared secret per install.** The installId already is one, and adding a
  second value to keep in step buys nothing.
- **Signing the payload.** Real protection, but every hub would need a keypair
  and a rotation story for a threat that ends at "somebody made our numbers look
  better than they are".
- **A curated allowlist.** Honest and unscalable. Worth revisiting if the
  verified tier is ever gamed at scale.

## Open questions

1. **Do unverified installs count in "cafés sharing"?** I say yes, reported
   separately, because the install count is a fact about our software and the
   impact figures are a claim about the world.
2. **How long does a verification last before it is rechecked?** A day matches
   the ping rhythm and costs one request per café per day.
3. **What happens when a verified café's numbers stop agreeing?** Drift is
   expected: the push and the fetch are minutes apart. A tolerance, or compare
   only the fetched numbers and ignore the pushed ones entirely. The second is
   simpler and strictly better, and probably right.
