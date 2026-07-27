#!/usr/bin/env bash
#
# Put the telemetry collector on the internet.
#
# Installs the nginx vhost, tests it, and reloads. Safe to run again: it makes
# no change unless the config is different, and it never leaves nginx unable to
# reload, because a failing test is rolled back before anything is applied.
#
# Usage:
#   ./scripts/install-nginx.sh              # install and reload
#   ./scripts/install-nginx.sh --dry-run    # say what it would do, change nothing
#   ./scripts/install-nginx.sh --remove     # take the site down again
#
set -euo pipefail

SITE="repaircafetelemetry.bzwrd.co.uk"
UPSTREAM_PORT=5040
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/nginx/$SITE.conf"
AVAILABLE="/etc/nginx/sites-available/$SITE"
ENABLED="/etc/nginx/sites-enabled/$SITE"
CERT="/etc/ssl/certs/cloudflare/cloudflare_bzwrd.pem"
KEY="/etc/ssl/certs/cloudflare/cloudflare_bzwrd.key"

DRY_RUN=0
REMOVE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --remove)  REMOVE=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
info()  { printf '  %s\n' "$*"; }
step()  { printf '\n== %s\n' "$*"; }
die()   { red "FAILED: $*"; exit 1; }

# ── Run as root, without making the caller remember to ────────────────
if [[ $EUID -ne 0 ]]; then
  command -v sudo >/dev/null || die "this needs root and sudo is not installed"
  echo "Re-running with sudo..."
  exec sudo -- "$0" "$@"
fi

# ── Taking it down ────────────────────────────────────────────────────
if [[ $REMOVE -eq 1 ]]; then
  step "Removing $SITE"
  if [[ -L $ENABLED || -e $ENABLED ]]; then
    rm -f "$ENABLED"
    info "unlinked $ENABLED"
  else
    info "was not enabled, nothing to unlink"
  fi
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx
    green "Done. $SITE is no longer served. $AVAILABLE was left in place."
  else
    die "nginx config is broken after removal, not reloading. Run: nginx -t"
  fi
  exit 0
fi

# ── Checks, all of them, before touching anything ─────────────────────
step "Checking before changing anything"

[[ -f $SRC ]] || die "vhost source not found at $SRC"
info "vhost source        $SRC"

command -v nginx >/dev/null || die "nginx is not installed"
[[ -d /etc/nginx/sites-available && -d /etc/nginx/sites-enabled ]] \
  || die "this box does not use sites-available/sites-enabled"
info "nginx               $(nginx -v 2>&1 | sed 's/^nginx version: //')"

[[ -r $CERT ]] || die "certificate not readable at $CERT"
[[ -r $KEY  ]] || die "certificate key not readable at $KEY"
CERT_EXPIRY="$(openssl x509 -enddate -noout -in "$CERT" 2>/dev/null | cut -d= -f2 || echo unknown)"
info "certificate         $CERT (expires $CERT_EXPIRY)"

# The backend has to be up, or we would publish a 502 to the world.
if curl -fsS --max-time 5 "http://127.0.0.1:$UPSTREAM_PORT/health" >/dev/null 2>&1; then
  info "backend             127.0.0.1:$UPSTREAM_PORT is healthy"
else
  die "nothing healthy on 127.0.0.1:$UPSTREAM_PORT. Start it first: docker compose up -d"
fi

# Somebody else claiming this name would make which vhost wins a coin toss.
# This is exactly how mac-app-tracker.protolab.live ended up serving the hub.
CLASH="$(grep -RlE "^\s*server_name\s+.*\b${SITE//./\\.}\b" /etc/nginx/sites-enabled/ 2>/dev/null \
         | grep -v "/$SITE\$" || true)"
if [[ -n $CLASH ]]; then
  red "Another enabled vhost already answers for $SITE:"
  echo "$CLASH" | sed 's/^/    /'
  die "resolve that first, or the two will fight over the name"
fi
info "name clash          none"

# Warn if some other site is already pointed at our port.
PORT_USERS="$(grep -RlE "proxy_pass\s+https?://127\.0\.0\.1:$UPSTREAM_PORT\b" /etc/nginx/sites-enabled/ 2>/dev/null \
              | grep -v "/$SITE\$" || true)"
if [[ -n $PORT_USERS ]]; then
  red "Warning: these vhosts also proxy to port $UPSTREAM_PORT:"
  echo "$PORT_USERS" | sed 's/^/    /'
  info "continuing, but that is probably a mistake"
fi

if [[ -f $AVAILABLE ]] && cmp -s "$SRC" "$AVAILABLE" && [[ -L $ENABLED ]]; then
  info "state               already installed and identical"
  ALREADY_CURRENT=1
else
  ALREADY_CURRENT=0
fi

if [[ $DRY_RUN -eq 1 ]]; then
  step "Dry run, nothing changed"
  if [[ $ALREADY_CURRENT -eq 1 ]]; then
    info "nothing to do"
  else
    info "would copy    $SRC -> $AVAILABLE"
    info "would link    $ENABLED -> $AVAILABLE"
    info "would run     nginx -t && systemctl reload nginx"
  fi
  exit 0
fi

# ── Apply, keeping a way back ─────────────────────────────────────────
step "Installing"

BACKUP=""
if [[ -f $AVAILABLE ]]; then
  BACKUP="$AVAILABLE.bak.$(date +%Y%m%d-%H%M%S)"
  cp -p "$AVAILABLE" "$BACKUP"
  info "backed up existing  $BACKUP"
fi

install -o root -g root -m 0644 "$SRC" "$AVAILABLE"
info "wrote               $AVAILABLE"

if [[ ! -L $ENABLED ]]; then
  ln -sfn "$AVAILABLE" "$ENABLED"
  info "linked              $ENABLED"
else
  info "link               already present"
fi

step "Testing the configuration"
if ! nginx -t 2>&1 | sed 's/^/  /'; then
  red "nginx rejected the configuration. Rolling back."
  rm -f "$ENABLED"
  if [[ -n $BACKUP ]]; then
    mv -f "$BACKUP" "$AVAILABLE"
    info "restored the previous vhost"
  else
    rm -f "$AVAILABLE"
    info "removed the vhost we just wrote"
  fi
  nginx -t >/dev/null 2>&1 || red "nginx was already broken before this script ran"
  die "nothing was reloaded, the running config is untouched"
fi

step "Reloading nginx"
systemctl reload nginx
info "reloaded"

# ── Prove it actually works ───────────────────────────────────────────
step "Checking it responds"

# `systemctl reload` returns as soon as nginx has been signalled, not when the
# new workers are serving. Asking straight away gets answered by an old worker
# that has never heard of this site, which looks exactly like a broken install.
# So try for a few seconds before believing a bad answer.
#
# --resolve rather than -H Host, so the TLS handshake carries the right server
# name too. An IP in the URL sends no SNI at all.
LOCAL_CODE=000
for attempt in $(seq 1 10); do
  LOCAL_CODE="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
                --resolve "$SITE:443:127.0.0.1" "https://$SITE/health" || echo 000)"
  [[ $LOCAL_CODE == 200 ]] && break
  sleep 0.5
done
if [[ $LOCAL_CODE == 200 ]]; then
  info "through nginx       200 OK"
else
  red "through nginx       $LOCAL_CODE (expected 200, gave it 5 seconds)"
  info "check: tail /var/log/nginx/repaircafetelemetry.error.log"
fi

if getent hosts "$SITE" >/dev/null 2>&1; then
  PUBLIC_CODE=000
  for attempt in $(seq 1 6); do
    PUBLIC_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$SITE/health" || echo 000)"
    [[ $PUBLIC_CODE == 200 ]] && break
    sleep 1
  done
  if [[ $PUBLIC_CODE == 200 ]]; then
    green "Public            https://$SITE/health -> 200"
  else
    red "Public            https://$SITE/health -> $PUBLIC_CODE"
    info "if this is 5xx, give Cloudflare a minute and try again"
  fi
else
  step "One thing left: DNS"
  info "$SITE does not resolve yet."
  info "Add a PROXIED A record for it in Cloudflare, pointing at this host:"
  info "    $(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo 'this host IP')"
  info "Keep the proxy on. CF-IPCountry is where the country comes from,"
  info "which is how the collector avoids ever storing an address."
fi

echo
green "Done."
