#!/usr/bin/env bash
# Guided, interactive production setup for Purrlor — see docs/deployment.md for the full
# explanation of what each step below does and why. This script automates the mechanical parts
# of that guide: checking the server is big enough (adding swap if it isn't), an optional outbound
# proxy, installing Docker/certbot/nginx, provisioning a Matrix homeserver (Continuwuity) with
# your admin account and the voice bot's account already created — or wiring up one you already
# run — generating secrets, walking you through DNS, requesting a TLS certificate, writing the
# nginx config, opening the firewall, and bringing the docker-compose stack up with voice and push
# already pointed at this deployment. Nothing is left to set inside the app.
#
# The easy way in is the one-line installer (install.sh at the repo root), which clones the repo
# and runs this. By hand, from the repo root, as root: sudo bash deploy/setup.sh
# Safe to re-run: it asks before overwriting an existing .env (keeping it keeps every secret and
# account in it), skips accounts that already exist, and skips re-requesting a certificate that's
# already valid for the domains you enter.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

log()  { printf '\n==> %s\n' "$1"; }
warn() { printf '\n!!  %s\n' "$1" >&2; }
die()  { warn "$1"; exit 1; }

# ask NAME "Prompt text" "default"  -> sets $REPLY_VALUE
ask() {
  local __prompt="$1" __default="${2-}" __input
  if [ -n "$__default" ]; then
    read -r -p "$__prompt [$__default]: " __input || true
    REPLY_VALUE="${__input:-$__default}"
  else
    while true; do
      read -r -p "$__prompt: " __input || true
      if [ -n "$__input" ]; then REPLY_VALUE="$__input"; break; fi
      echo "  (required)"
    done
  fi
}

# ask_secret "Prompt text" -> sets $REPLY_VALUE, input not echoed
ask_secret() {
  local __prompt="$1" __input
  while true; do
    read -r -s -p "$__prompt: " __input || true
    echo
    if [ -n "$__input" ]; then REPLY_VALUE="$__input"; break; fi
    echo "  (required)"
  done
}

# ask_new_password "Prompt text" -> sets $REPLY_VALUE; asks twice, at least 8 characters (the
# same minimum Purrlor's own register screen enforces).
ask_new_password() {
  local __prompt="$1" __first
  while true; do
    ask_secret "$__prompt"
    __first="$REPLY_VALUE"
    if [ "${#__first}" -lt 8 ]; then echo "  (at least 8 characters)"; continue; fi
    ask_secret "Type it again"
    if [ "$REPLY_VALUE" = "$__first" ]; then break; fi
    echo "  (didn't match — try again)"
  done
}

# choose "Prompt" DEFAULT_NUMBER "label 1" "label 2" ... -> sets $REPLY_CHOICE to the number picked
choose() {
  local __prompt="$1" __default="$2" __input __i=1
  shift 2
  echo "$__prompt"
  for __label in "$@"; do
    echo "  $__i) $__label"
    __i=$((__i + 1))
  done
  while true; do
    read -r -p "Choice [$__default]: " __input || true
    __input="${__input:-$__default}"
    if [ "$__input" -ge 1 ] 2>/dev/null && [ "$__input" -le "$#" ]; then REPLY_CHOICE="$__input"; return; fi
    echo "  (pick 1-$#)"
  done
}

# env_set KEY VALUE -> sets KEY=VALUE in .env, replacing an existing line for KEY rather than
# appending a duplicate (so re-runs don't pile up conflicting values).
env_set() {
  local __key="$1" __value="$2" __tmp
  __tmp="$(mktemp)"
  if [ -f .env ]; then grep -v "^$__key=" .env > "$__tmp" || true; fi
  printf '%s=%s\n' "$__key" "$__value" >> "$__tmp"
  cat "$__tmp" > .env
  rm -f "$__tmp"
  chmod 600 .env
}

# mask_url URL -> the URL with any user:password@ replaced by ***@, for printing.
mask_url() { printf '%s' "$1" | sed -E 's#^([a-zA-Z]+://)[^@/]*@#\1***@#'; }

# The host part of a proxy URL (no scheme, credentials, port or path).
url_host() { printf '%s' "$1" | sed -E 's#^[a-zA-Z]+://##; s#^[^@/]*@##; s#[:/].*$##'; }

confirm() {
  local __prompt="$1" __default="${2:-y}" __input
  read -r -p "$__prompt [$([ "$__default" = y ] && echo 'Y/n' || echo 'y/N')]: " __input || true
  __input="${__input:-$__default}"
  case "$__input" in
    y|Y|yes|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

need_cmd() { command -v "$1" >/dev/null 2>&1; }

# json_escape STRING -> prints STRING with backslashes/double-quotes escaped for embedding in a
# JSON string literal. Good enough for typical passwords/usernames; doesn't handle raw control
# characters, which don't show up in anything a person types at these prompts.
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# register_account LOCALPART PASSWORD REGISTRATION_TOKEN -> sets REGISTERED_USER_ID and
# REGISTERED_ACCESS_TOKEN. Talks to the freshly-provisioned homeserver's own client-server API
# (127.0.0.1:8008, before nginx/TLS are even involved) via the standard two-step UIAA registration
# flow Matrix homeservers use: the first call gets rejected with a session id and the list of
# required stages, the second call repeats the request with that session id plus the
# m.login.registration_token stage completed. Confirmed against a real Continuwuity container
# that a single follow-up call is enough here (no further stages) — see the README changelog
# entry for this feature for how that was verified.
register_account() {
  local __local="$1" __password="$2" __token="$3"
  local __esc_local __esc_pw __esc_token __session __resp
  __esc_local="$(json_escape "$__local")"
  __esc_pw="$(json_escape "$__password")"
  __esc_token="$(json_escape "$__token")"
  __resp="$(curl -s -X POST "http://$LOCAL_ADDR:8008/_matrix/client/v3/register" \
    -d "{\"username\":\"$__esc_local\",\"password\":\"$__esc_pw\"}")"
  __session="$(printf '%s' "$__resp" | grep -o '"session":"[^"]*"' | cut -d'"' -f4)"
  [ -n "$__session" ] || die "Registering @$__local on the new homeserver failed (no session in response: $__resp) — check: docker compose -f deploy/docker-compose.yml --profile matrix logs matrix"
  __resp="$(curl -s -X POST "http://$LOCAL_ADDR:8008/_matrix/client/v3/register" \
    -d "{\"username\":\"$__esc_local\",\"password\":\"$__esc_pw\",\"auth\":{\"type\":\"m.login.registration_token\",\"token\":\"$__esc_token\",\"session\":\"$__session\"}}")"
  REGISTERED_USER_ID="$(printf '%s' "$__resp" | grep -o '"user_id":"[^"]*"' | cut -d'"' -f4)"
  REGISTERED_ACCESS_TOKEN="$(printf '%s' "$__resp" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)"
  [ -n "$REGISTERED_USER_ID" ] && [ -n "$REGISTERED_ACCESS_TOKEN" ] || die "Registering @$__local on the new homeserver failed (unexpected response: $__resp)"
}

# username_taken LOCALPART -> succeeds if that account already exists on the new homeserver (a
# re-run over an existing data volume). The spec's availability check answers M_USER_IN_USE for a
# taken name; anything else (available, or an invalid name) is left for registration to report.
username_taken() {
  curl -s "http://$LOCAL_ADDR:8008/_matrix/client/v3/register/available?username=$1" | grep -q M_USER_IN_USE
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

if [ "$(id -u)" -ne 0 ]; then
  die "Run this as root (sudo bash deploy/setup.sh) — it installs system packages and writes to /etc/nginx and /etc/letsencrypt."
fi

# Two families are supported: Alpine (apk + OpenRC) and Debian/Ubuntu (apt + systemd). Everything
# that differs between them goes through the few helpers below.
if need_cmd apk; then
  OS_FAMILY=alpine
elif need_cmd apt-get; then
  OS_FAMILY=debian
else
  die "This script supports Alpine, Debian and Ubuntu. On other systems, follow docs/deployment.md by hand."
fi
if need_cmd systemctl && [ -d /run/systemd/system ]; then
  INIT=systemd
elif need_cmd rc-service; then
  INIT=openrc
else
  die "Couldn't find systemd or OpenRC to manage services with."
fi

APT_UPDATED=false
pkg_install() {
  if [ "$OS_FAMILY" = alpine ]; then
    apk add --no-cache "$@"
  else
    if [ "$APT_UPDATED" = false ]; then apt-get update -qq; APT_UPDATED=true; fi
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
  fi
}

# Docker and certbot are in Alpine's "community" repository, which a minimal install often has
# commented out. Turns on the one matching the enabled "main" repository (same mirror, same
# release), never edge.
alpine_enable_community() {
  local __main __community
  __main="$(grep -E '^[^#].*/main/?$' /etc/apk/repositories | head -n1 || true)"
  [ -n "$__main" ] || return 0
  __community="$(printf '%s' "$__main" | sed -E 's#/main/?$#/community#')"
  grep -qxF "$__community" /etc/apk/repositories && return 0
  echo "  enabling Alpine's community repository ($__community)"
  echo "$__community" >> /etc/apk/repositories
  apk update -q
}

# svc ACTION NAME — start/stop/restart/reload a service, whichever init system this is.
svc() {
  if [ "$INIT" = systemd ]; then systemctl "$1" "$2"; else rc-service "$2" "$1"; fi
}

# svc_enable NAME — start it now and at every boot.
svc_enable() {
  if [ "$INIT" = systemd ]; then
    systemctl enable --now "$1" >/dev/null 2>&1 || systemctl start "$1"
  else
    rc-update add "$1" default >/dev/null 2>&1 || true
    rc-service "$1" status >/dev/null 2>&1 || rc-service "$1" start
  fi
}

log "Purrlor guided deploy — see docs/deployment.md for the full explanation of each step."
echo "  system: $OS_FAMILY ($INIT)"

# What this script itself runs before it installs anything else. Stock Alpine has neither.
if ! need_cmd curl || ! need_cmd openssl; then
  log "Installing curl and openssl"
  pkg_install curl openssl ca-certificates >/dev/null
fi

# ---------------------------------------------------------------------------
# Is this server big enough?
# ---------------------------------------------------------------------------

log "Checking this server"

# Purrlor's images come prebuilt (.github/workflows/images.yml), so the server only has to *run*
# them: the homeserver, the voice server, two small Node services and nginx — about 1 GB in
# practice. Building them here instead (only if the download fails) needs ~4 GB, which is checked
# at that point, not now.
MEM_MB="$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)"
SWAP_MB="$(awk '/^SwapTotal:/ {print int($2/1024)}' /proc/meminfo)"
echo "  memory: ${MEM_MB} MB RAM, ${SWAP_MB} MB swap"

# A container (LXC, OpenVZ/Virtuozzo, Docker) rather than a real VM: swap can't be added, and
# Docker itself often can't run inside one unless the host allows nesting.
IN_CONTAINER=""
if [ -e /proc/vz ] && [ ! -e /proc/bc ]; then IN_CONTAINER="OpenVZ/Virtuozzo"
elif grep -qa 'container=lxc' /proc/1/environ 2>/dev/null; then IN_CONTAINER="LXC"
elif [ -e /.dockerenv ] || [ -e /run/.containerenv ]; then IN_CONTAINER="Docker/Podman"
fi
if [ -n "$IN_CONTAINER" ]; then
  echo "  note: this looks like a $IN_CONTAINER container rather than a full virtual machine."
fi

if [ $((MEM_MB + SWAP_MB)) -lt 900 ]; then
  warn "This server has ${MEM_MB} MB of RAM. Purrlor needs about 1 GB to run (its homeserver, voice
    server and web services together) — on less, parts of it get killed for lack of memory.
    A 1 GB VPS is the minimum; 2 GB is comfortable."
  confirm "Try anyway?" n || die "Re-run on a server with at least 1 GB of RAM."
fi

# Swap as a cushion on smaller servers: not needed to run, but it turns a memory spike into a
# brief slowdown instead of a killed process.
if [ $((MEM_MB + SWAP_MB)) -lt 2000 ] && [ ! -f /swapfile ]; then
  SWAP_TO_ADD=$((2048 - SWAP_MB))
  echo "  A little swap gives a small server room for memory spikes."
  if confirm "Add a ${SWAP_TO_ADD} MB swap file at /swapfile?" y; then
    if { fallocate -l "${SWAP_TO_ADD}M" /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count="$SWAP_TO_ADD" 2>/dev/null; } \
      && chmod 600 /swapfile && mkswap /swapfile >/dev/null 2>&1 && swapon /swapfile 2>/dev/null; then
      grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
      # systemd mounts fstab swap by itself; OpenRC only with its swap service in the boot runlevel.
      if [ "$INIT" = openrc ]; then rc-update add swap boot >/dev/null 2>&1 || true; fi
      SWAP_MB=$((SWAP_MB + SWAP_TO_ADD))
      echo "  ok   swap added (and kept across reboots)"
    else
      rm -f /swapfile
      warn "This server doesn't allow adding swap${IN_CONTAINER:+ (normal for a $IN_CONTAINER container)}.
    Continuing without it — fine as long as there's enough RAM."
    fi
  fi
else
  echo "  ok   enough memory"
fi

DISK_FREE_GB="$(df -Pk "$REPO_ROOT" | awk 'NR==2 {print int($4/1048576)}')"
if [ "$DISK_FREE_GB" -lt 8 ]; then
  warn "Only ${DISK_FREE_GB} GB of disk free here. Docker images and the build need about 8 GB, plus
    room for uploaded media over time."
  confirm "Continue anyway?" n || die "Free up some disk space (or use a bigger disk), then re-run."
else
  echo "  ok   ${DISK_FREE_GB} GB of disk free"
fi

# Something other than nginx on 80/443 (Apache, Caddy, another stack's proxy) would make both the
# certificate request and nginx fail later with a much less obvious message.
# port_holder PORT -> the name of the program listening on that TCP port (empty if none).
port_holder() {
  if need_cmd ss; then
    ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'users:(("[^"]*"' | head -n1 | cut -d'"' -f2 || true
  else
    # busybox netstat: "tcp 0 0 0.0.0.0:80 0.0.0.0:* LISTEN 1234/nginx: master"
    netstat -ltnp 2>/dev/null | awk -v p=":$1" '$4 ~ p"$" {print $7}' | head -n1 | cut -d/ -f2 | cut -d: -f1 || true
  fi
}
# Only a problem if nginx is going to run on this server (asked below); remembered until then.
PORT_CONFLICT=""
for port in 80 443; do
  HOLDER="$(port_holder "$port")"
  if [ -n "$HOLDER" ] && [ "$HOLDER" != nginx ]; then PORT_CONFLICT="$port:$HOLDER"; break; fi
done

# ---------------------------------------------------------------------------
# Outbound proxy (first, because everything after this may need the internet)
# ---------------------------------------------------------------------------

# Every in-stack hostname, plus loopback: container-to-container traffic (token-server ->
# livekit:7880, token-server -> matrix:8008) and this script's own health checks must never be
# sent to the proxy.
DEFAULT_NO_PROXY="localhost,127.0.0.1,::1,livekit,token-server,push-gateway,web,matrix"
OUTBOUND_PROXY=""
OUTBOUND_NO_PROXY=""
# What this host itself (apk/apt, Docker's image pulls, certbot renewal) sends through the proxy:
# the proxy when "everything" goes through it, empty when only Purrlor's services use it.
HOST_PROXY=""
LOCAL_ADDR=127.0.0.1

log "Outbound proxy"
echo "Some networks only reach the internet through an HTTP(S) forward proxy — a corporate egress"
echo "proxy, or one that keeps this server's own IP out of outgoing requests (a NekoProxy agent,"
echo "say). If so, this script uses it for its own downloads and configures Docker, certificate"
echo "renewal, and the services that make outbound requests (federation, push delivery, OpenID"
echo "checks) to use it too. Inbound traffic — people reaching Purrlor, voice/video — is unaffected."
CONTAINER_PROXY=""
if confirm "Does this server need an outbound proxy to reach the internet?" n; then
  echo "  e.g. http://localhost:8080 for a NekoProxy agent on this server, http://10.0.0.1:8080 for one"
  echo "  elsewhere; add user:password@ before the host if it uses a login."
  while true; do
    ask "Proxy address" ""
    OUTBOUND_PROXY="$REPLY_VALUE"
    case "$OUTBOUND_PROXY" in *://*) ;; *) OUTBOUND_PROXY="http://$OUTBOUND_PROXY" ;; esac
    if printf '%s' "$OUTBOUND_PROXY" | grep -Eq '^https?://[^[:space:]]+$'; then break; fi
    echo "  (an HTTP(S) proxy address — SOCKS isn't supported by the Node services)"
  done

  # Containers have their own loopback, so a proxy on this host's 127.0.0.1 is unreachable from
  # them. They reach this host as host.docker.internal (docker-compose.yml maps it), which works as
  # long as the proxy listens on more than loopback — checked once Docker is installed.
  CONTAINER_PROXY="$OUTBOUND_PROXY"
  case "$(url_host "$OUTBOUND_PROXY")" in
    localhost|127.*|::1|'[::1]')
      CONTAINER_PROXY="$(printf '%s' "$OUTBOUND_PROXY" | sed -E 's#^(https?://([^@/]*@)?)(localhost|127\.[0-9.]+|\[::1\])#\1host.docker.internal#')"
      echo "  note: Purrlor's services run in containers, which reach this server as host.docker.internal —"
      echo "        they'll use $(mask_url "$CONTAINER_PROXY"). The proxy has to listen on more than"
      echo "        127.0.0.1 for that (NekoProxy: its listen address set to 0.0.0.0 or this server's IP)."
      ;;
  esac

  ask "Extra hosts that should bypass the proxy (comma-separated, blank for none)" "-"
  OUTBOUND_NO_PROXY="$DEFAULT_NO_PROXY,host.docker.internal"
  if [ "$REPLY_VALUE" != "-" ]; then OUTBOUND_NO_PROXY="$OUTBOUND_NO_PROXY,$REPLY_VALUE"; fi

  # A server that also reaches the internet directly only needs the proxy for what it's *for* —
  # keeping Purrlor's own outgoing traffic (federation, push, OpenID checks) off this server's IP.
  # Package installs, Docker image pulls and certificate renewal can go direct, so a proxy problem
  # can't stop the install itself.
  PROXY_SCOPE=all
  if curl --noproxy '*' -fsS -4 -m 8 -o /dev/null https://ifconfig.me 2>/dev/null; then
    echo "  This server also reaches the internet directly."
    choose "What should go through the proxy?" 1 \
      "Only Purrlor's own traffic: federation, push, sign-in checks (recommended — downloads go direct)" \
      "Everything: also this installer's downloads, Docker image pulls and certificate renewal"
    if [ "$REPLY_CHOICE" = 1 ]; then PROXY_SCOPE=services; fi
  fi

  echo "Testing $(mask_url "$OUTBOUND_PROXY") from this server ..."
  PROXY_ERR="$(mktemp)"
  if EGRESS_IP="$(curl -fsS -4 -m 15 -x "$OUTBOUND_PROXY" https://ifconfig.me 2>"$PROXY_ERR")" && [ -n "$EGRESS_IP" ]; then
    echo "  ok   proxy works — outbound requests will appear to come from $EGRESS_IP"
  else
    PROXY_HOST="$(url_host "$OUTBOUND_PROXY")"
    PROXY_PORT="$(printf '%s' "$OUTBOUND_PROXY" | sed -E 's#^[a-zA-Z]+://([^@/]*@)?[^:/]*:?([0-9]*).*#\2#')"
    PROXY_PORT="${PROXY_PORT:-80}"
    if { timeout 5 bash -c "exec 3<>/dev/tcp/$PROXY_HOST/$PROXY_PORT"; } 2>/dev/null; then
      WHY="This server connects to $PROXY_HOST:$PROXY_PORT, but the request through it failed — usually a
    login it wants (user:password@host:port), or it isn't an HTTP(S) forward proxy (NekoProxy: the
    agent's Forward proxy port, not a reverse-proxy port)."
    else
      # How this server would reach it: through a WireGuard/VPN interface, or just handed to the
      # LAN's default gateway — which, for a private address, usually means nowhere.
      ROUTE="$(ip route get "$PROXY_HOST" 2>/dev/null | head -n1)"
      ROUTE_DEV="$(printf '%s' "$ROUTE" | sed -n 's/.* dev \([^ ]*\).*/\1/p')"
      ROUTE_VIA="$(printf '%s' "$ROUTE" | sed -n 's/.* via \([^ ]*\).*/\1/p')"
      if [ -n "$ROUTE_VIA" ] && ! printf '%s' "$ROUTE_DEV" | grep -Eq '^(wg|tun|tap|tailscale|zt|nb)'; then
        WHY="This server has no route of its own to $PROXY_HOST: it hands it to the gateway $ROUTE_VIA on
    $ROUTE_DEV like any internet address, not to a WireGuard interface — this server isn't on that
    private network. Either make it a peer of that WireGuard network; or give it a route there
    (e.g. on the router: $PROXY_HOST's network via the LAN address of a machine that is on it) and
    let that proxy accept this server (NekoProxy only admits its forward-proxy port on the
    WireGuard interface); or run a proxy this server can reach (a NekoProxy internal agent on
    this server, routed via your VPS agent, then use http://localhost:<its port>)."
      else
        WHY="This server can't open a connection to $PROXY_HOST:$PROXY_PORT at all (a timeout means something
    drops it; the route is: ${ROUTE:-none}). Check the proxy is running on that address and port,
    and that the proxy host's firewall allows this server (NekoProxy: its firewall rules)."
      fi
    fi
    warn "The proxy test failed: $(tr '\n' ' ' < "$PROXY_ERR")
    $WHY"
    if confirm "Carry on without a proxy instead?" y; then
      OUTBOUND_PROXY="" CONTAINER_PROXY="" OUTBOUND_NO_PROXY=""
    else
      confirm "Keep this proxy anyway?" n || die "Fix the proxy (or its address), then re-run."
    fi
  fi
  rm -f "$PROXY_ERR"

  # This script's own curl/apk/apt/certbot/get.docker.com calls, when everything goes through it.
  # Both spellings, since tools disagree about which one they read.
  if [ -n "$OUTBOUND_PROXY" ] && [ "$PROXY_SCOPE" = all ]; then
    HOST_PROXY="$OUTBOUND_PROXY"
    export http_proxy="$OUTBOUND_PROXY" https_proxy="$OUTBOUND_PROXY" no_proxy="$OUTBOUND_NO_PROXY"
    export HTTP_PROXY="$OUTBOUND_PROXY" HTTPS_PROXY="$OUTBOUND_PROXY" NO_PROXY="$OUTBOUND_NO_PROXY"
  fi
fi

# ---------------------------------------------------------------------------
# Where nginx runs
# ---------------------------------------------------------------------------

log "Web server (nginx)"
echo "Purrlor needs nginx in front of it for HTTPS. The usual setup runs it on this server and this"
echo "script handles everything. If you already run nginx on another machine that forwards traffic"
echo "here over a private network (a WireGuard tunnel, often with Cloudflare in front), pick 2: this"
echo "script then writes the nginx config for that machine instead of setting up nginx here."
choose "Where should nginx run?" 1 \
  "On this server (recommended — sets up nginx and HTTPS certificates for you)" \
  "On another server I already run"
if [ "$REPLY_CHOICE" = 2 ]; then
  EDGE_MODE=true
  echo
  echo "Your nginx server reaches this one over a private network. Addresses on this server:"
  ip -4 -o addr show 2>/dev/null | awk '$2 != "lo" && $2 !~ /^(docker|br-|veth)/ {split($4, a, "/"); printf "    %-12s %s\n", $2, a[1]}'
  # Default: the first private address, preferring a WireGuard-looking interface.
  PRIVATE_DEFAULT="$(ip -4 -o addr show 2>/dev/null | awk '$2 != "lo" && $2 !~ /^(docker|br-|veth)/ {split($4, a, "/"); print $2, a[1]}' \
    | awk '$2 ~ /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)/ {print ($1 ~ /^wg/ ? 0 : 1), $2}' \
    | sort -n | head -n1 | cut -d' ' -f2)"
  while true; do
    ask "This server's private address (what your nginx server connects to)" "$PRIVATE_DEFAULT"
    BIND_ADDR_VALUE="$REPLY_VALUE"
    if ip -4 -o addr show 2>/dev/null | grep -q " $BIND_ADDR_VALUE/"; then break; fi
    echo "  ($BIND_ADDR_VALUE isn't one of this server's addresses — pick one from the list above)"
  done
  if [ "$BIND_ADDR_VALUE" = 0.0.0.0 ]; then die "Not 0.0.0.0 — these ports have no HTTPS or login of their own; use the private address."; fi
  LOCAL_ADDR="$BIND_ADDR_VALUE"
else
  EDGE_MODE=false
  BIND_ADDR_VALUE=""
  if [ -n "$PORT_CONFLICT" ]; then
    die "Port ${PORT_CONFLICT%%:*} is already in use by '${PORT_CONFLICT#*:}'. nginx on this server needs ports 80
    and 443 — stop and disable '${PORT_CONFLICT#*:}', or re-run and pick 'On another server' if that's
    your existing web server."
  fi
fi

# ---------------------------------------------------------------------------
# Collect configuration
# ---------------------------------------------------------------------------

log "Domains"
echo "Purrlor lives on a few subdomains of a domain you own: the app itself, and its voice server"
echo "(plus the Matrix homeserver, if this install runs one). You'll be shown exactly which DNS"
echo "records to create in a moment."
while true; do
  ask "Your domain (e.g. example.com)" ""
  BASE_DOMAIN="$(printf '%s' "$REPLY_VALUE" | tr 'A-Z' 'a-z' | sed -E 's#^[a-z]+://##; s#/.*$##; s#^\.+|\.+$##g')"
  if printf '%s' "$BASE_DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'; then break; fi
  echo "  (that doesn't look like a domain name — just the name, like example.com)"
done

ask "Address for the app" "app.$BASE_DOMAIN"
APP_DOMAIN="$REPLY_VALUE"
ask "Address for the voice/video server" "livekit.$BASE_DOMAIN"
LIVEKIT_DOMAIN="$REPLY_VALUE"

echo
if confirm "Hide this server's IP behind a TURN relay for voice/video (optional hardening, needs one more DNS record)?" n; then
  ENABLE_TURN=true
  ask "TURN domain" "turn.$BASE_DOMAIN"
  TURN_DOMAIN="$REPLY_VALUE"
else
  ENABLE_TURN=false
fi

# The token server and push gateway are served under the app's own address
# (https://APP/api/livekit/..., https://APP/api/push/...) — two fewer DNS records and certificate
# names than giving each its own subdomain, and nothing for anyone to configure.
TOKEN_ENDPOINT="https://$APP_DOMAIN/api/livekit/token"
PUSH_GATEWAY_URL="https://$APP_DOMAIN/api/push"
LIVEKIT_URL="wss://$LIVEKIT_DOMAIN"

# Never through the proxy: this is the address people and other servers reach THIS host on, which
# with a proxy configured is exactly what ifconfig.me would otherwise not report. Comes back empty
# on a network with no direct egress at all — then it's typed in by hand.
DETECTED_IP="$(curl -fsS -4 -m 10 --noproxy '*' ifconfig.me 2>/dev/null || true)"
if [ "$EDGE_MODE" = true ]; then
  echo
  echo "Voice and video connect straight to an IP address, not through nginx's HTTP. With nginx on"
  echo "another server, that's usually that server's public IP — it relays ports 7881/7882 here (the"
  echo "config written for it includes that) — or this server's own, if those ports reach it directly."
  ask "Public IP for voice/video" "$DETECTED_IP"
else
  ask "This server's public IP" "$DETECTED_IP"
fi
HOST_IP_VALUE="$REPLY_VALUE"

while true; do
  ask "Your email (Let's Encrypt sends certificate expiry warnings here)" ""
  ADMIN_EMAIL="$REPLY_VALUE"
  if printf '%s' "$ADMIN_EMAIL" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'; then break; fi
  echo "  (that doesn't look like an email address)"
done

log "Matrix homeserver"
echo "Purrlor is a Matrix client — it needs a homeserver to talk to. This install can run one for"
echo "you on this same server (Continuwuity: a lightweight, federation-capable Matrix server with"
echo "no separate database to manage), with your admin account and the voice bot's account"
echo "created automatically. Only say no if you already run a homeserver you want to use instead."
if confirm "Set up a new Matrix homeserver as part of this install?" y; then
  PROVISION_MATRIX=true
  MATRIX_DOMAIN="matrix.$BASE_DOMAIN"
  echo
  echo "  It will be served at https://$MATRIX_DOMAIN. Its *server name* is the part after the colon"
  echo "  in everyone's address, and it's permanent — baked into every account and room it creates."
  echo
  # Using the bare domain for nicer addresses means this server has to answer for it (two small
  # files that point Matrix at $MATRIX_DOMAIN). If the bare domain already hosts a website
  # somewhere else, that would take it over — so in that case the default is the subdomain.
  BASE_RESOLVES="$(getent ahostsv4 "$BASE_DOMAIN" 2>/dev/null | awk '{print $1}' | head -n1 || true)"
  if [ -n "$BASE_RESOLVES" ] && [ "$BASE_RESOLVES" != "$HOST_IP_VALUE" ]; then
    echo "  $BASE_DOMAIN already points somewhere else ($BASE_RESOLVES) — probably an existing website."
    SERVER_NAME_DEFAULT=2
  else
    SERVER_NAME_DEFAULT=1
  fi
  choose "What should people's addresses look like?" "$SERVER_NAME_DEFAULT" \
    "@name:$BASE_DOMAIN  (needs $BASE_DOMAIN itself pointed at this server — replaces any website there)" \
    "@name:$MATRIX_DOMAIN  (leaves $BASE_DOMAIN alone — pick this if it hosts a website)"
  if [ "$REPLY_CHOICE" = 1 ]; then
    MATRIX_SERVER_NAME="$BASE_DOMAIN"
    MATRIX_DELEGATED=true
  else
    MATRIX_SERVER_NAME="$MATRIX_DOMAIN"
    MATRIX_DELEGATED=false
  fi

  echo
  choose "Who can create accounts on it?" 1 \
    "Invite-only: people need a sign-up code you hand out (recommended)" \
    "Closed: only you and the voice bot; add people later from the admin room"
  if [ "$REPLY_CHOICE" = 1 ]; then MATRIX_REGISTRATION_MODE=token; else MATRIX_REGISTRATION_MODE=closed; fi
else
  PROVISION_MATRIX=false
  MATRIX_DELEGATED=false
fi

DNS_CHECK_DOMAINS=("$APP_DOMAIN" "$LIVEKIT_DOMAIN")
if [ "$ENABLE_TURN" = true ]; then
  DNS_CHECK_DOMAINS+=("$TURN_DOMAIN")
fi
if [ "$PROVISION_MATRIX" = true ]; then
  DNS_CHECK_DOMAINS+=("$MATRIX_DOMAIN")
  if [ "$MATRIX_DELEGATED" = true ]; then DNS_CHECK_DOMAINS+=("$BASE_DOMAIN"); fi
fi

# Cloudflare's published IPv4 ranges (https://www.cloudflare.com/ips-v4). A proxied ("orange
# cloud") record resolves to one of these instead of the server — which is fine: Cloudflare passes
# the traffic on.
CLOUDFLARE_V4="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18
108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15
104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"
ip_to_int() { local IFS=.; set -- $1; echo $(( ($1 << 24) + ($2 << 16) + ($3 << 8) + $4 )); }
is_cloudflare_ip() {
  local __ip __range __net __bits __mask
  printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || return 1
  __ip="$(ip_to_int "$1")"
  for __range in $CLOUDFLARE_V4; do
    __net="$(ip_to_int "${__range%/*}")"; __bits="${__range#*/}"
    __mask=$(( (0xFFFFFFFF << (32 - __bits)) & 0xFFFFFFFF ))
    if [ $(( __ip & __mask )) -eq $(( __net & __mask )) ]; then return 0; fi
  done
  return 1
}
SAW_CLOUDFLARE=false

# dns_report -> prints one line per domain and returns 0 only if every one is right: an A record
# for this server, and no AAAA record pointing elsewhere (Let's Encrypt prefers IPv6 when there is
# one, so a stale AAAA fails the certificate even with a perfect A record).
dns_report() {
  local __all_ok=0 __d __v4 __v6 __my_v6
  __my_v6="$(ip -6 addr show scope global 2>/dev/null | awk '/inet6/ {print $2}' | cut -d/ -f1 | tr '\n' ' ')"
  for __d in "${DNS_CHECK_DOMAINS[@]}"; do
    __v4="$(getent ahostsv4 "$__d" 2>/dev/null | awk '{print $1}' | head -n1 || true)"
    __v6="$(getent ahostsv6 "$__d" 2>/dev/null | awk '{print $1}' | grep ':' | grep -v '^::ffff:' | head -n1 || true)"
    if [ -z "$__v4" ]; then
      printf '  %-6s %-40s %s\n' "WAIT" "$__d" "-> <no A record yet>"
      __all_ok=1
    elif is_cloudflare_ip "$__v4"; then
      printf '  %-6s %-40s %s\n' "ok" "$__d" "-> Cloudflare ($__v4), proxied"
      SAW_CLOUDFLARE=true
    elif [ "$EDGE_MODE" = true ]; then
      # With nginx elsewhere, the records point at that server — whatever its IP is.
      printf '  %-6s %-40s %s\n' "ok" "$__d" "-> $__v4"
    elif [ "$__v4" != "$HOST_IP_VALUE" ]; then
      printf '  %-6s %-40s %s\n' "WAIT" "$__d" "-> $__v4 (needs $HOST_IP_VALUE)"
      __all_ok=1
    elif [ -n "$__v6" ] && ! printf ' %s ' "$__my_v6" | grep -q " $__v6 "; then
      printf '  %-6s %-40s %s\n' "FIX" "$__d" "-> has an AAAA (IPv6) record $__v6 that isn't this server — delete it"
      __all_ok=1
    else
      printf '  %-6s %-40s %s\n' "ok" "$__d" "-> $__v4"
    fi
  done
  return $__all_ok
}

log "DNS"
if [ "$EDGE_MODE" = true ]; then
  echo "At your DNS provider, these names should point at your nginx server (or be proxied through"
  echo "Cloudflare to it), like the sites it already serves:"
  echo
  for d in "${DNS_CHECK_DOMAINS[@]}"; do printf '    %s\n' "$d"; done
else
  echo "At your DNS provider, create these records (type A, pointing at this server):"
  echo
  for d in "${DNS_CHECK_DOMAINS[@]}"; do
    printf '    %-40s A    %s\n' "$d" "$HOST_IP_VALUE"
  done
fi
echo
echo "Cloudflare's proxy (orange cloud) is fine: voice and video connect to the IP above directly,"
echo "not through it. New records usually work within a few minutes."
while true; do
  echo
  if dns_report; then
    echo "  All set."
    if [ "$SAW_CLOUDFLARE" = true ] && [ "$EDGE_MODE" = false ]; then
      echo
      echo "  Cloudflare: set SSL/TLS to \"Full (strict)\". If the certificate request below fails,"
      echo "  turn off \"Always Use HTTPS\" until it succeeds (Let's Encrypt checks over plain HTTP)."
    fi
    break
  fi
  echo
  read -r -p "Press Enter to check again, c to continue anyway, or q to quit: " __dns_answer || true
  case "$__dns_answer" in
    c|C) warn "Continuing with DNS not ready — the certificate request below will fail for any name that isn't pointed here yet."; break ;;
    q|Q) die "Re-run this script once the records are in place." ;;
  esac
done

if [ "$PROVISION_MATRIX" = true ]; then
  log "New homeserver accounts (both get created automatically once the homeserver is up)"
  ask "Local part for the token server's bot account" "purrlor-voice-bot"
  BOT_LOCALPART="$REPLY_VALUE"
  BOT_PASSWORD="$(openssl rand -base64 24)"
  echo "  ok   bot password generated (never shown anywhere — only its access token ends up in .env)"

  ask "Local part for your own account (this becomes the homeserver's admin)" ""
  ADMIN_LOCALPART="$REPLY_VALUE"
  ask_new_password "Password for that account"
  ADMIN_PASSWORD="$REPLY_VALUE"

  # The web client talks to it at its public URL, like any other Matrix client would.
  PURRLOR_HOMESERVER_URL="https://$MATRIX_DOMAIN"
else
  log "Your existing Matrix homeserver (NOT one of the domains above — Purrlor is a client, not a homeserver)"
  ask "Homeserver URL (e.g. https://matrix.$BASE_DOMAIN)" ""
  HOMESERVER_URL="$REPLY_VALUE"

  echo
  echo "The token server needs a dedicated bot account on that homeserver — see docs/deployment.md"
  echo "Step 4 if you haven't created one yet (register an account, then grab a long-lived access"
  echo "token for it, e.g. via Element: Settings -> Help & About -> Advanced -> Access Token)."
  ask "Bot's full Matrix user ID (e.g. @purrlor-voice-bot:$BASE_DOMAIN)" ""
  BOT_USER_ID="$REPLY_VALUE"
  ask_secret "Bot's access token"
  BOT_ACCESS_TOKEN="$REPLY_VALUE"

  echo "Verifying that access token against $HOMESERVER_URL ..."
  WHOAMI="$(curl -fsS -H "Authorization: Bearer $BOT_ACCESS_TOKEN" "$HOMESERVER_URL/_matrix/client/v3/account/whoami" 2>/dev/null || true)"
  if printf '%s' "$WHOAMI" | grep -q "$BOT_USER_ID"; then
    echo "  ok   token is valid for $BOT_USER_ID"
  else
    warn "Couldn't confirm that token against $HOMESERVER_URL (got: ${WHOAMI:-no response}). Continuing anyway — double check .env afterwards if voice calls don't work."
  fi

  PURRLOR_HOMESERVER_URL="$HOMESERVER_URL"
fi

echo
echo "The web client can be locked to this homeserver: its login and register screens then show"
echo "$PURRLOR_HOMESERVER_URL instead of asking for a homeserver. Say no only if people should be"
echo "able to use this Purrlor deployment with accounts on other Matrix servers."
if ! confirm "Lock the web client to $PURRLOR_HOMESERVER_URL?" y; then
  PURRLOR_HOMESERVER_URL=""
fi

# ---------------------------------------------------------------------------
# Install missing tools
# ---------------------------------------------------------------------------

log "Checking required tools"

if [ "$OS_FAMILY" = alpine ]; then
  alpine_enable_community
  if ! need_cmd docker || ! docker compose version >/dev/null 2>&1; then
    log "Installing Docker"
    pkg_install docker docker-cli-compose
  fi
  # Alpine installs services stopped and not started at boot; the stack's restart policies only
  # bring it back after a reboot if Docker itself comes back.
  svc_enable docker
  for _ in $(seq 1 20); do docker info >/dev/null 2>&1 && break; sleep 1; done
  docker info >/dev/null 2>&1 || die "Docker is installed but its daemon didn't start — check: rc-service docker status"
else
  if ! need_cmd docker; then
    log "Installing Docker"
    curl -fsSL https://get.docker.com | sh
  fi
  svc_enable docker
fi
if ! docker compose version >/dev/null 2>&1; then
  if [ "$OS_FAMILY" = alpine ]; then
    die "Docker is installed but 'docker compose' isn't — run: apk add docker-cli-compose, then re-run."
  fi
  die "Docker is installed but 'docker compose' isn't — install docker-compose-plugin and re-run."
fi

LOCAL_TOOLS=()
if [ "$EDGE_MODE" = false ]; then LOCAL_TOOLS=(certbot nginx); fi
for cmd in "${LOCAL_TOOLS[@]}"; do
  if ! need_cmd "$cmd"; then
    log "Installing $cmd"
    if ! pkg_install "$cmd"; then
      if [ "$OS_FAMILY" = alpine ]; then
        die "Couldn't install $cmd with apk (the error is above). Check /etc/apk/repositories has the
    'community' repository for your Alpine release, and that 'apk update' works${HOST_PROXY:+ through the proxy}."
      fi
      die "Couldn't install $cmd with apt (the error is above). Check that 'apt-get update' works${HOST_PROXY:+ through the proxy}."
    fi
  fi
done

# Certificates renew from a systemd timer on Debian/Ubuntu (certbot's package installs it). Alpine
# has no timer, so renewal runs from cron's daily jobs instead — without it the certificate
# quietly expires in 90 days.
if [ "$INIT" = openrc ] && [ "$EDGE_MODE" = false ]; then
  cat > /etc/periodic/daily/purrlor-certbot-renew <<RENEW_EOF
#!/bin/sh
# Written by Purrlor deploy/setup.sh — renews Let's Encrypt certificates when they're due (it's a
# no-op otherwise); the renewal hooks in /etc/letsencrypt/renewal-hooks reload nginx afterwards.
${HOST_PROXY:+export HTTP_PROXY='$HOST_PROXY' HTTPS_PROXY='$HOST_PROXY' NO_PROXY='$OUTBOUND_NO_PROXY'}
certbot renew -q
RENEW_EOF
  chmod 700 /etc/periodic/daily/purrlor-certbot-renew
  svc_enable crond
fi

echo "  ok   docker, docker compose, certbot, nginx, openssl all present"

# write_systemd_proxy_dropin UNIT -> writes (or refreshes) a drop-in giving UNIT the proxy
# variables. Prints "changed" when the file's content actually changed, so the caller only
# restarts what it has to. Mode 600: the proxy URL may carry credentials, and systemd reads
# drop-ins as root anyway.
write_systemd_proxy_dropin() {
  local __unit="$1" __dir="/etc/systemd/system/$1.d" __file __new
  __file="$__dir/purrlor-proxy.conf"
  # systemd expands %-specifiers in Environment=, and a percent-encoded proxy password is full
  # of them — %% is a literal %.
  local __p="${HOST_PROXY//%/%%}" __n="${OUTBOUND_NO_PROXY//%/%%}"
  __new="$(printf '# Written by Purrlor deploy/setup.sh — outbound proxy for %s.\n[Service]\nEnvironment="HTTP_PROXY=%s" "HTTPS_PROXY=%s" "NO_PROXY=%s"\n' \
    "$__unit" "$__p" "$__p" "$__n")"
  if [ -f "$__file" ] && [ "$(cat "$__file")" = "$__new" ]; then return; fi
  mkdir -p "$__dir"
  printf '%s\n' "$__new" > "$__file"
  chmod 600 "$__file"
  echo changed
}

# write_openrc_docker_proxy -> the same for OpenRC, whose Docker service sources /etc/conf.d/docker
# as a shell script. Replaces its own marked block, so a re-run with another proxy doesn't stack.
write_openrc_docker_proxy() {
  local __file=/etc/conf.d/docker __new __block
  __block="$(printf '# BEGIN purrlor-proxy\nexport HTTP_PROXY=%q HTTPS_PROXY=%q NO_PROXY=%q\n# END purrlor-proxy' \
    "$HOST_PROXY" "$HOST_PROXY" "$OUTBOUND_NO_PROXY")"
  touch "$__file"
  if grep -qF "$__block" "$__file"; then return; fi
  __new="$(sed '/^# BEGIN purrlor-proxy$/,/^# END purrlor-proxy$/d' "$__file")"
  printf '%s\n%s\n' "$__new" "$__block" > "$__file"
  chmod 600 "$__file"
  echo changed
}

# A proxy an earlier run gave Docker, now that it shouldn't have one: take it back out, or image
# pulls keep going through (and failing on) it.
DOCKER_PROXY_REMOVED=false
if [ -z "$HOST_PROXY" ]; then
  if [ -f /etc/conf.d/docker ] && grep -q '^# BEGIN purrlor-proxy$' /etc/conf.d/docker; then
    sed -i '/^# BEGIN purrlor-proxy$/,/^# END purrlor-proxy$/d' /etc/conf.d/docker
    DOCKER_PROXY_REMOVED=true
  fi
  if [ -f /etc/systemd/system/docker.service.d/purrlor-proxy.conf ]; then
    rm -f /etc/systemd/system/docker.service.d/purrlor-proxy.conf
    systemctl daemon-reload
    DOCKER_PROXY_REMOVED=true
  fi
  if [ "$DOCKER_PROXY_REMOVED" = true ]; then
    log "Taking the proxy back out of Docker's own settings (image pulls go direct now)"
    svc restart docker
    for _ in $(seq 1 20); do docker info >/dev/null 2>&1 && break; sleep 1; done
  fi
fi

if [ -n "$HOST_PROXY" ] && [ "$INIT" = openrc ]; then
  log "Configuring the outbound proxy for Docker"
  if [ "$(write_openrc_docker_proxy)" = changed ]; then
    if [ -n "$(docker ps -q 2>/dev/null)" ]; then
      warn "Docker has to restart to pick up the proxy, which briefly stops the containers already
    running on this host (ones with a restart policy come back on their own)."
      confirm "Restart Docker now?" y || die "Docker can't pull images through the proxy until it restarts — re-run when it's OK to."
    fi
    svc restart docker
    for _ in $(seq 1 20); do docker info >/dev/null 2>&1 && break; sleep 1; done
    echo "  ok   Docker daemon uses the proxy for image pulls"
  else
    echo "  ok   Docker daemon already configured for this proxy"
  fi
  echo "  ok   certificate renewal (/etc/periodic/daily/purrlor-certbot-renew) uses the proxy"
fi

if [ -n "$HOST_PROXY" ] && [ "$INIT" = systemd ]; then
  log "Configuring the outbound proxy for Docker and certificate renewal"

  if [ "$(write_systemd_proxy_dropin docker.service)" = changed ]; then
    systemctl daemon-reload
    if [ -n "$(docker ps -q 2>/dev/null)" ]; then
      warn "Docker has to restart to pick up the proxy, which briefly stops the containers already
    running on this host (ones with a restart policy come back on their own)."
      confirm "Restart Docker now?" y || die "Docker can't pull images through the proxy until it restarts — re-run when it's OK to."
    fi
    systemctl restart docker
    echo "  ok   Docker daemon uses the proxy for image pulls"
  else
    echo "  ok   Docker daemon already configured for this proxy"
  fi

  # certbot's renewal runs from a systemd timer, outside this script's environment — without this
  # it can't reach Let's Encrypt, and certificates quietly expire in ~90 days. apt's certbot and
  # the snap one name their unit differently.
  CERTBOT_UNIT=""
  for unit in certbot.service snap.certbot.renew.service; do
    if systemctl cat "$unit" >/dev/null 2>&1; then CERTBOT_UNIT="$unit"; break; fi
  done
  if [ -n "$CERTBOT_UNIT" ]; then
    if [ "$(write_systemd_proxy_dropin "$CERTBOT_UNIT")" = changed ]; then systemctl daemon-reload; fi
    echo "  ok   certificate renewal ($CERTBOT_UNIT) uses the proxy"
  else
    warn "Couldn't find certbot's renewal service to give it the proxy — renewals may fail. Set
    HTTPS_PROXY for whatever runs 'certbot renew' on this host."
  fi
fi

if [ -n "$CONTAINER_PROXY" ]; then
  log "Checking Purrlor's services will be able to use the proxy"
  PROXY_ERR="$(mktemp)"
  if ! docker pull -q curlimages/curl:latest >/dev/null 2>"$PROXY_ERR"; then
    PULL_HINT=""
    if [ -n "$HOST_PROXY" ]; then
      PULL_HINT="Docker downloads through the proxy right now. Re-running and choosing \"Only Purrlor's own
    traffic\" at the proxy question lets downloads go direct."
    fi
    warn "Skipping this check: Docker couldn't download its small test image: $(tr '\n' ' ' < "$PROXY_ERR")
    $PULL_HINT"
  elif docker run --rm --add-host host.docker.internal:host-gateway curlimages/curl:latest \
       -fsS -m 15 -x "$CONTAINER_PROXY" https://ifconfig.me >/dev/null 2>"$PROXY_ERR"; then
    echo "  ok   containers reach the internet through $(mask_url "$CONTAINER_PROXY")"
  else
    PROXY_HOST="$(url_host "$OUTBOUND_PROXY")"
    if ip -4 -o addr show 2>/dev/null | grep -q " $PROXY_HOST/" || [ "$CONTAINER_PROXY" != "$OUTBOUND_PROXY" ]; then
      WHY="The proxy runs on this server, and containers reach it from Docker's own network
    (172.16.0.0/12, the docker0 bridge), not from this server's address. Either the proxy only
    listens on another address, or its firewall only allows some interfaces — NekoProxy's firewall
    baseline admits the forward-proxy port on the WireGuard interface only. Allow the Docker
    network to reach port $(printf '%s' "$CONTAINER_PROXY" | sed -E 's#.*:([0-9]+)/?$#\1#') (a NekoProxy firewall rule, or run it where containers can reach)."
    else
      WHY="This server reaches the proxy, but its containers don't. Their traffic leaves through this
    server too, so this is usually a firewall on this server blocking forwarded traffic from
    Docker's network to $PROXY_HOST (check iptables' FORWARD chain)."
    fi
    warn "Containers couldn't use $(mask_url "$CONTAINER_PROXY"): $(tr '\n' ' ' < "$PROXY_ERR")
    $WHY
    Until this works, federation, push notifications and OpenID checks will fail."
    confirm "Continue anyway?" n || die "Fix that, then re-run."
  fi
  rm -f "$PROXY_ERR"
fi

# ---------------------------------------------------------------------------
# .env — keep the existing one, or generate secrets and write a new one
# ---------------------------------------------------------------------------

# env_get KEY -> prints KEY's value from .env (empty if absent). Reads single keys instead of
# sourcing the file, so a hand-edited .env with something shell-unfriendly in it can't break this.
env_get() { grep "^$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- || true; }

KEEP_ENV=false
if [ -f .env ] && ! confirm "$(printf '\n.env already exists — overwrite it? (no = keep every secret and account in it, and only update the settings asked about above)')" n; then
  KEEP_ENV=true
fi

if [ "$KEEP_ENV" = true ]; then
  log "Keeping existing .env, updating this run's settings in it"
  env_set PURRLOR_HOMESERVER_URL "$PURRLOR_HOMESERVER_URL"
  env_set PURRLOR_LIVEKIT_URL "$LIVEKIT_URL"
  env_set PURRLOR_TOKEN_ENDPOINT "$TOKEN_ENDPOINT"
  env_set PURRLOR_PUSH_GATEWAY_URL "$PUSH_GATEWAY_URL"
  env_set ALLOWED_ORIGINS "https://$APP_DOMAIN"
  env_set HOST_IP "$HOST_IP_VALUE"
  env_set OUTBOUND_PROXY "$OUTBOUND_PROXY"
  env_set OUTBOUND_NO_PROXY "$OUTBOUND_NO_PROXY"
  env_set CONTAINER_PROXY "$CONTAINER_PROXY"
  env_set BIND_ADDR "$BIND_ADDR_VALUE"
  env_set PURRLOR_EDGE "$EDGE_MODE"

  if [ "$PROVISION_MATRIX" = true ]; then
    EXISTING_SERVER_NAME="$(env_get MATRIX_SERVER_NAME)"
    if [ -n "$EXISTING_SERVER_NAME" ] && [ "$EXISTING_SERVER_NAME" != "$MATRIX_SERVER_NAME" ]; then
      die "This .env's homeserver is named $EXISTING_SERVER_NAME, not $MATRIX_SERVER_NAME — a homeserver's name can't change once it has data. Re-run with base domain $EXISTING_SERVER_NAME."
    fi
    env_set COMPOSE_PROFILES matrix
    env_set MATRIX_SERVER_NAME "$MATRIX_SERVER_NAME"
    # Reuse the token the running homeserver already has, so the bot registration below (if it
    # still needs doing) matches it.
    MATRIX_REGISTRATION_TOKEN="$(env_get MATRIX_REGISTRATION_TOKEN)"
    if [ -z "$MATRIX_REGISTRATION_TOKEN" ]; then
      MATRIX_REGISTRATION_TOKEN="$(openssl rand -hex 32)"
      env_set MATRIX_REGISTRATION_TOKEN "$MATRIX_REGISTRATION_TOKEN"
    fi
    # Registration has to be open while setup creates accounts; it's closed again below if chosen.
    env_set MATRIX_ALLOW_REGISTRATION true
  else
    env_set MATRIX_HOMESERVER_URL "$HOMESERVER_URL"
    env_set MATRIX_BOT_USER_ID "$BOT_USER_ID"
    env_set MATRIX_BOT_ACCESS_TOKEN "$BOT_ACCESS_TOKEN"
  fi
  echo "  ok   .env updated"
else
  log "Generating secrets"

  LIVEKIT_API_KEY="$(openssl rand -hex 16)"
  LIVEKIT_API_SECRET="$(openssl rand -hex 16)"
  echo "  ok   LiveKit API key/secret"

  if [ "$PROVISION_MATRIX" = true ]; then
    MATRIX_REGISTRATION_TOKEN="$(openssl rand -hex 32)"
    echo "  ok   Matrix registration token"
  fi

  # npx downloads web-push: direct, or through the containers' copy of the proxy when everything
  # goes through it.
  VAPID_PROXY=""
  if [ -n "$HOST_PROXY" ]; then VAPID_PROXY="$CONTAINER_PROXY"; fi
  VAPID_JSON="$(docker run --rm --add-host host.docker.internal:host-gateway \
    -e HTTPS_PROXY="$VAPID_PROXY" -e HTTP_PROXY="$VAPID_PROXY" \
    node:20-alpine npx --yes web-push generate-vapid-keys --json 2>/dev/null || true)"
  VAPID_PUBLIC_KEY="$(printf '%s' "$VAPID_JSON" | grep -o '"publicKey":"[^"]*"' | cut -d'"' -f4)"
  VAPID_PRIVATE_KEY="$(printf '%s' "$VAPID_JSON" | grep -o '"privateKey":"[^"]*"' | cut -d'"' -f4)"
  if [ -z "$VAPID_PUBLIC_KEY" ] || [ -z "$VAPID_PRIVATE_KEY" ]; then
    die "Couldn't generate VAPID keys automatically (docker run node:20-alpine failed?). Run 'npx web-push generate-vapid-keys' yourself and fill VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY into .env manually, then re-run."
  fi
  echo "  ok   VAPID key pair for push notifications"

  log "Writing .env"
  {
    cat <<ENV_EOF
# Generated by deploy/setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ) — see .env.example for what each
# of these means, and docs/deployment.md for the full guide.

LIVEKIT_API_KEY=$LIVEKIT_API_KEY
LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET
HOST_IP=$HOST_IP_VALUE
ALLOWED_ORIGINS=https://$APP_DOMAIN

VOICE_MODERATOR_POWER_LEVEL=50

# Unset means "every space on this homeserver the voice bot is invited into", which is what you
# want on a private server. Set it to a comma-separated list of space room IDs to narrow that.
# VOICE_ALLOWED_SPACES=

VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY=$VAPID_PRIVATE_KEY
VAPID_SUBJECT=mailto:$ADMIN_EMAIL

# The homeserver the web client's login screen is locked to (empty: it asks).
PURRLOR_HOMESERVER_URL=$PURRLOR_HOMESERVER_URL

# This deployment's voice server and push gateway. Spaces and accounts use them automatically, so
# nobody has to paste URLs into settings.
PURRLOR_LIVEKIT_URL=$LIVEKIT_URL
PURRLOR_TOKEN_ENDPOINT=$TOKEN_ENDPOINT
PURRLOR_PUSH_GATEWAY_URL=$PUSH_GATEWAY_URL

# Outbound HTTP(S) proxy for the services that reach the internet (empty: direct). The containers'
# own copy differs when the proxy is on this host's loopback (host.docker.internal instead).
OUTBOUND_PROXY=$OUTBOUND_PROXY
OUTBOUND_NO_PROXY=$OUTBOUND_NO_PROXY
CONTAINER_PROXY=$CONTAINER_PROXY

# Where the services listen for nginx: empty is 127.0.0.1 (nginx on this server); with nginx on
# another server, this server's private address (PURRLOR_EDGE=true).
BIND_ADDR=$BIND_ADDR_VALUE
PURRLOR_EDGE=$EDGE_MODE
ENV_EOF
    if [ "$PROVISION_MATRIX" = true ]; then
      cat <<MATRIX_ENV_EOF

# Bundled homeserver. COMPOSE_PROFILES makes every \`docker compose --env-file .env up\` include it.
COMPOSE_PROFILES=matrix
MATRIX_SERVER_NAME=$MATRIX_SERVER_NAME
MATRIX_REGISTRATION_TOKEN=$MATRIX_REGISTRATION_TOKEN
MATRIX_ALLOW_REGISTRATION=true
# MATRIX_HOMESERVER_URL / MATRIX_BOT_USER_ID / MATRIX_BOT_ACCESS_TOKEN are added below once the
# new homeserver is up and its accounts are created.
MATRIX_ENV_EOF
    else
      cat <<EXISTING_ENV_EOF

MATRIX_HOMESERVER_URL=$HOMESERVER_URL
MATRIX_BOT_USER_ID=$BOT_USER_ID
MATRIX_BOT_ACCESS_TOKEN=$BOT_ACCESS_TOKEN
EXISTING_ENV_EOF
    fi
  } > .env
  chmod 600 .env
  echo "  ok   wrote .env (mode 600)"
fi

# ---------------------------------------------------------------------------
# TLS certificate
# ---------------------------------------------------------------------------

CERT_DIR="/etc/letsencrypt/live/$APP_DOMAIN"

# cert_covers_all -> succeeds when the existing certificate names every domain this run needs. A
# re-run that adds one (turning on TURN, say) has to get a new certificate, or that name serves
# someone else's certificate and browsers refuse it.
cert_covers_all() {
  local __sans __d
  [ -f "$CERT_DIR/fullchain.pem" ] || return 1
  __sans="$(openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -ext subjectAltName 2>/dev/null | tr ',' '\n' | sed -n 's/.*DNS://p')"
  for __d in "${DNS_CHECK_DOMAINS[@]}"; do
    printf '%s\n' "$__sans" | grep -qx "$__d" || return 1
  done
  openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -checkend 2592000 >/dev/null 2>&1
}

if [ "$EDGE_MODE" = true ]; then
  log "Skipping the certificate — your nginx server holds it (the config written below says how)"
elif cert_covers_all; then
  log "Reusing the existing certificate at $CERT_DIR (it covers every domain and isn't about to expire)"
else
  log "Requesting a TLS certificate (stopping nginx briefly to free port 80)"
  svc stop nginx >/dev/null 2>&1 || true
  CERTBOT_DOMAIN_ARGS=()
  for d in "${DNS_CHECK_DOMAINS[@]}"; do
    CERTBOT_DOMAIN_ARGS+=(-d "$d")
  done
  # --cert-name keeps it at the same path when a re-run adds a name, instead of creating
  # $APP_DOMAIN-0001 alongside the one nginx is configured to use.
  certbot certonly --standalone --cert-name "$APP_DOMAIN" --expand \
    "${CERTBOT_DOMAIN_ARGS[@]}" \
    --agree-tos -m "$ADMIN_EMAIL" --no-eff-email --non-interactive \
    || die "certbot failed — check DNS has propagated for all domains and that port 80 is reachable from the internet, then re-run."

  mkdir -p /etc/letsencrypt/renewal-hooks/deploy
  if [ "$INIT" = systemd ]; then RELOAD_NGINX="systemctl reload nginx"; else RELOAD_NGINX="rc-service nginx reload"; fi
  cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<HOOK_EOF
#!/bin/sh
$RELOAD_NGINX
HOOK_EOF
  chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
  echo "  ok   certificate issued, renewal reload-hook installed"
fi

if [ "$ENABLE_TURN" = true ] && [ "$EDGE_MODE" = true ]; then
  warn "The TURN relay needs its TLS certificate on this server, which the nginx server holds —
    copy fullchain.pem and privkey.pem into deploy/livekit-certs/ yourself, then 'purrlor restart livekit'."
fi
if [ "$ENABLE_TURN" = true ] && [ "$EDGE_MODE" = false ]; then
  log "Copying the TLS cert into deploy/livekit-certs for LiveKit's TURN relay"
  # LiveKit reads its own files, not /etc/letsencrypt directly (that path is Docker-host-only,
  # not visible inside the container) — copying into a repo-local directory that's already bind-
  # mounted into the livekit service (docker-compose.yml) is simpler than adding a second mount
  # of the real letsencrypt tree.
  mkdir -p deploy/livekit-certs
  cp "$CERT_DIR/fullchain.pem" "$CERT_DIR/privkey.pem" deploy/livekit-certs/
  chmod 644 deploy/livekit-certs/fullchain.pem
  chmod 600 deploy/livekit-certs/privkey.pem
  echo "  ok   copied to deploy/livekit-certs/"

  cat > /etc/letsencrypt/renewal-hooks/deploy/refresh-livekit-turn-cert.sh <<HOOK_EOF
#!/bin/sh
cp "$CERT_DIR/fullchain.pem" "$CERT_DIR/privkey.pem" "$REPO_ROOT/deploy/livekit-certs/"
cd "$REPO_ROOT" && docker compose -f deploy/docker-compose.yml restart livekit
HOOK_EOF
  chmod +x /etc/letsencrypt/renewal-hooks/deploy/refresh-livekit-turn-cert.sh
  echo "  ok   renewal hook installed (keeps the TURN cert fresh and restarts livekit automatically)"

  log "Enabling the TURN relay in deploy/livekit.yaml"
  # A full rewrite rather than editing the checked-in file in place — simpler and less fragile
  # than patching around the commented-out turn: block with sed, at the cost of overwriting any
  # hand edits to livekit.yaml once TURN is turned on. Re-running setup.sh with TURN enabled
  # rewrites this file again every time; leave TURN off if you've customized this file by hand
  # and don't want it touched.
  #
  # tls_port 5349 (the standard TURNS port) rather than 443 — this same host's nginx already owns
  # 443 for the four proxied services above, so LiveKit can't also bind it. That means TURN
  # traffic here is NOT disguised as ordinary HTTPS the way running it on a dedicated host with a
  # free 443 would allow — still hides the origin IP behind the TURN relay's own IP, just
  # distinguishable as TURN by port number to anyone actually looking. Good enough for the
  # "hide my home IP" goal; a from-scratch nginx `stream {}` SNI-passthrough setup could reclaim
  # 443 for this too, but that's real added complexity this guided script doesn't attempt.
  cat > deploy/livekit.yaml <<LIVEKIT_EOF
# LiveKit server configuration — regenerated by deploy/setup.sh with the TURN relay enabled for
# $TURN_DOMAIN. See docs/deployment.md's TURN section and docs/voice-architecture.md for how this
# fits into the overall voice flow.

port: 7880

rtc:
  udp_port: 7882
  tcp_port: 7881
  allow_tcp_fallback: true
  use_external_ip: false

turn:
  enabled: true
  domain: $TURN_DOMAIN
  tls_port: 5349
  udp_port: 3478
  cert_file: /etc/livekit/certs/fullchain.pem
  key_file: /etc/livekit/certs/privkey.pem

# Overridden at runtime by the LIVEKIT_KEYS env var (docker-compose.yml), sourced from .env.
keys:
  placeholder: not-used-in-docker

logging:
  level: info

room:
  max_participants: 50
  empty_timeout: 300
  departure_timeout: 20
  # NOTE: enabled_codecs, once specified, REPLACES LiveKit's entire built-in codec list rather
  # than adding to it — omitting audio/opus here would silently break every mic publish.
  enabled_codecs:
    - mime: audio/opus
    - mime: video/h264
    - mime: video/vp8
LIVEKIT_EOF
  echo "  ok   wrote deploy/livekit.yaml with TURN enabled for $TURN_DOMAIN"
fi

# ---------------------------------------------------------------------------
# nginx
# ---------------------------------------------------------------------------

log "Writing nginx config"

# Debian/Ubuntu: sites-available, enabled by a symlink in sites-enabled. Alpine: every file in
# http.d is loaded as it is.
# With nginx on another server, the same config is written here for you to copy over, pointing
# at this server's private address instead of 127.0.0.1.
UPSTREAM="$LOCAL_ADDR"
if [ "$EDGE_MODE" = true ]; then
  mkdir -p "$REPO_ROOT/deploy/edge"
  NGINX_SITE="$REPO_ROOT/deploy/edge/purrlor.conf"
elif [ -d /etc/nginx/sites-available ] || [ "$OS_FAMILY" = debian ]; then
  mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
  NGINX_SITE=/etc/nginx/sites-available/purrlor.conf
else
  mkdir -p /etc/nginx/http.d
  NGINX_SITE=/etc/nginx/http.d/purrlor.conf
fi

cat > "$NGINX_SITE" <<NGINX_EOF
server {
    listen 443 ssl http2;
    server_name $APP_DOMAIN;

    ssl_certificate $CERT_DIR/fullchain.pem;
    ssl_certificate_key $CERT_DIR/privkey.pem;

    location / {
        proxy_pass http://$UPSTREAM:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # The token server, under the app's own address — what PURRLOR_TOKEN_ENDPOINT points at.
    location /api/livekit/ {
        proxy_pass http://$UPSTREAM:3001/api/livekit/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # The push gateway, likewise (PURRLOR_PUSH_GATEWAY_URL). The trailing slashes strip the
    # prefix: /api/push/subscribe reaches the gateway as /subscribe.
    location /api/push/ {
        proxy_pass http://$UPSTREAM:3002/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}

server {
    listen 443 ssl http2;
    server_name $LIVEKIT_DOMAIN;

    ssl_certificate $CERT_DIR/fullchain.pem;
    ssl_certificate_key $CERT_DIR/privkey.pem;

    location / {
        proxy_pass http://$UPSTREAM:7880;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}

NGINX_EOF

REDIRECT_DOMAINS="$APP_DOMAIN $LIVEKIT_DOMAIN"

if [ "$PROVISION_MATRIX" = true ]; then
  REDIRECT_DOMAINS="$REDIRECT_DOMAINS $MATRIX_DOMAIN"
  echo "  ok   adding nginx blocks for the new homeserver ($MATRIX_DOMAIN, federation on 8448)"
  cat >> "$NGINX_SITE" <<MATRIX_NGINX_EOF

server {
    listen 443 ssl http2;
    server_name $MATRIX_DOMAIN;

    ssl_certificate $CERT_DIR/fullchain.pem;
    ssl_certificate_key $CERT_DIR/privkey.pem;

    # Continuwuity's own docs ask for this — its default request-body limit is smaller than
    # Matrix media uploads typically need.
    client_max_body_size 20M;

    # Tells other homeservers to federate over 443 rather than 8448. Without it, a server named
    # $MATRIX_DOMAIN is only reachable for federation on 8448 — which Cloudflare's proxy doesn't
    # carry, and an edge box may not forward.
    location = /.well-known/matrix/server {
        default_type application/json;
        return 200 '{"m.server": "$MATRIX_DOMAIN:443"}';
    }

    location / {
        proxy_pass http://$UPSTREAM:8008;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}

server {
    # Server-to-server federation traffic — a separate port because it can't share 443's TLS
    # SNI/cert-selection the way a browser client request can; same backend either way.
    listen 8448 ssl http2;
    server_name $MATRIX_DOMAIN;

    ssl_certificate $CERT_DIR/fullchain.pem;
    ssl_certificate_key $CERT_DIR/privkey.pem;

    client_max_body_size 20M;

    location / {
        proxy_pass http://$UPSTREAM:8008;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}

MATRIX_NGINX_EOF
  if [ "$MATRIX_DELEGATED" = true ]; then
    REDIRECT_DOMAINS="$REDIRECT_DOMAINS $BASE_DOMAIN"
    echo "  ok   and well-known delegation on $BASE_DOMAIN (addresses read @name:$BASE_DOMAIN)"
    cat >> "$NGINX_SITE" <<DELEGATION_NGINX_EOF

server {
    # The bare domain is never a real endpoint of its own — it only exists so Matrix user IDs
    # read as a clean @user:$BASE_DOMAIN while the actual homeserver runs at $MATRIX_DOMAIN.
    # These two well-known files are what tells other homeservers (and clients) where to find it.
    listen 443 ssl http2;
    server_name $BASE_DOMAIN;

    ssl_certificate $CERT_DIR/fullchain.pem;
    ssl_certificate_key $CERT_DIR/privkey.pem;

    location = /.well-known/matrix/server {
        default_type application/json;
        return 200 '{"m.server": "$MATRIX_DOMAIN:443"}';
    }
    location = /.well-known/matrix/client {
        default_type application/json;
        add_header Access-Control-Allow-Origin *;
        return 200 '{"m.homeserver": {"base_url": "https://$MATRIX_DOMAIN"}}';
    }
    location / {
        return 301 https://$APP_DOMAIN\$request_uri;
    }
}
DELEGATION_NGINX_EOF
  fi
fi

cat >> "$NGINX_SITE" <<REDIRECT_EOF

server {
    listen 80;
    server_name $REDIRECT_DOMAINS;
    return 301 https://\$host\$request_uri;
}
REDIRECT_EOF

# Earlier versions of this script wrote the same server blocks as nekous.conf, the project's old
# name. Left enabled next to purrlor.conf, every domain would be defined twice. Disabled and kept
# as a .bak rather than deleted, in case it was hand-edited.
if [ -e /etc/nginx/sites-enabled/nekous.conf ] || [ -e /etc/nginx/sites-available/nekous.conf ]; then
  rm -f /etc/nginx/sites-enabled/nekous.conf
  if [ -f /etc/nginx/sites-available/nekous.conf ]; then
    mv /etc/nginx/sites-available/nekous.conf /etc/nginx/sites-available/nekous.conf.bak
  fi
  echo "  ok   retired the old nekous.conf (kept as sites-available/nekous.conf.bak)"
fi

if [ "$EDGE_MODE" = true ]; then
  # LiveKit's media ports aren't HTTP; the edge relays them with nginx's stream module.
  cat > "$REPO_ROOT/deploy/edge/purrlor-stream.conf" <<STREAM_EOF
# Purrlor voice/video media, relayed to $UPSTREAM. These are server blocks for nginx's stream {}
# context (a sibling of http {}, not inside it), which needs the stream module:
#   Alpine:         apk add nginx-mod-stream, then copy this file to /etc/nginx/stream.d/purrlor.conf
#                   (installing the module sets up a stream {} that loads everything in stream.d/)
#   Debian/Ubuntu:  apt install libnginx-mod-stream, copy this file to /etc/nginx/purrlor-stream.conf,
#                   and add at the top level of /etc/nginx/nginx.conf (outside http {}):
#                     stream { include /etc/nginx/purrlor-stream.conf; }
#                   or, if nginx.conf already has a stream {} block, put just the include inside it.
server {
    listen 7881;
    proxy_pass $UPSTREAM:7881;
}
server {
    listen 7882 udp;
    proxy_pass $UPSTREAM:7882;
}
STREAM_EOF
  echo "  ok   wrote deploy/edge/purrlor.conf and deploy/edge/purrlor-stream.conf for your nginx server"
else
# nginx 1.25.1 moved HTTP/2 from a listen flag to its own directive and warns about the old form
# (Alpine ships the new one); older versions (Debian 12's 1.22) don't know the new directive at all.
# The config above is written in the old form, and rewritten here when this nginx is new enough.
NGINX_VERSION="$(nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9.]*\).*#\1#p')"
if printf '%s\n' "$NGINX_VERSION" | awk -F. '{ exit !($1 > 1 || ($1 == 1 && ($2 > 25 || ($2 == 25 && $3 >= 1)))) }'; then
  awk '{
    if (match($0, /listen (443|8448) ssl http2;/)) {
      indent = substr($0, 1, RSTART - 1); port = ($0 ~ /8448/) ? "8448" : "443"
      print indent "listen " port " ssl;"; print indent "http2 on;"
    } else print
  }' "$NGINX_SITE" > "$NGINX_SITE.tmp" && mv "$NGINX_SITE.tmp" "$NGINX_SITE"
fi

# The distro's stock site answers every name on port 80 as default_server; harmless next to ours,
# but it's a "Welcome to nginx" (or bare 404) page for anything that reaches this IP by mistake.
rm -f /etc/nginx/sites-enabled/default /etc/nginx/http.d/default.conf

if [ "$NGINX_SITE" = /etc/nginx/sites-available/purrlor.conf ]; then
  ln -sf /etc/nginx/sites-available/purrlor.conf /etc/nginx/sites-enabled/purrlor.conf
fi
nginx -t || die "nginx config test failed — check $NGINX_SITE"
svc_enable nginx
svc restart nginx
fi
echo "  ok   nginx configured and running"

# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------

# What has to be reachable from the internet. 7881/7882 carry the voice and video themselves and
# can't go through nginx; without them calls connect and then hear nothing.
if [ "$EDGE_MODE" = true ]; then
  # Only the media ports, and only if they reach this server directly rather than via the relay.
  FIREWALL_PORTS=("7881/tcp" "7882/udp")
else
  FIREWALL_PORTS=("80/tcp" "443/tcp" "7881/tcp" "7882/udp")
fi
if [ "$PROVISION_MATRIX" = true ] && [ "$EDGE_MODE" = false ]; then FIREWALL_PORTS+=("8448/tcp"); fi
if [ "$ENABLE_TURN" = true ]; then FIREWALL_PORTS+=("5349/tcp" "3478/udp"); fi

log "Firewall"
if need_cmd ufw && ufw status 2>/dev/null | grep -q '^Status: active'; then
  echo "ufw is active on this server. Purrlor needs: ${FIREWALL_PORTS[*]} (and SSH stays open)."
  if confirm "Open those ports in ufw?" y; then
    ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null
    for port in "${FIREWALL_PORTS[@]}"; do ufw allow "$port" >/dev/null; done
    echo "  ok   ufw allows ${FIREWALL_PORTS[*]}"
  fi
else
  echo "  ok   no local firewall to change (ufw isn't active)"
fi
echo "  If your provider has its own firewall (AWS security groups, Hetzner/Oracle/GCP firewall"
echo "  rules...), open these there too: ${FIREWALL_PORTS[*]}"

# ---------------------------------------------------------------------------
# Bring the stack up
# ---------------------------------------------------------------------------

COMPOSE_PROFILE_ARGS=()
if [ "$PROVISION_MATRIX" = true ]; then
  COMPOSE_PROFILE_ARGS=(--profile matrix)

  log "Starting the new homeserver first (its accounts need to exist before the rest of the stack can use them)"
  # The homeserver is an upstream image — nothing of ours to build.
  docker compose -f deploy/docker-compose.yml --env-file .env "${COMPOSE_PROFILE_ARGS[@]}" up -d matrix

  log "Waiting for it to come up"
  MATRIX_UP=false
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "http://$LOCAL_ADDR:8008/_matrix/client/versions" 2>/dev/null; then
      MATRIX_UP=true
      break
    fi
    sleep 2
  done
  [ "$MATRIX_UP" = true ] || die "The new homeserver didn't come up in time — check: docker compose -f deploy/docker-compose.yml --profile matrix logs matrix"
  echo "  ok   homeserver is up"

  if [ "$KEEP_ENV" = true ] && [ -n "$(env_get MATRIX_BOT_ACCESS_TOKEN)" ]; then
    BOT_USER_ID="$(env_get MATRIX_BOT_USER_ID)"
    echo "  ok   accounts were created on an earlier run ($BOT_USER_ID is already in .env)"
  else
    if username_taken "$ADMIN_LOCALPART"; then
      echo "  ok   @$ADMIN_LOCALPART:$MATRIX_SERVER_NAME already exists — leaving it (and its password) alone"
    else
      log "Reading its one-time bootstrap registration token"
      # Continuwuity generates and logs its OWN one-time token for the very first account — the
      # MATRIX_REGISTRATION_TOKEN we configured only activates once that first account exists.
      # Confirmed live against a real container; see the README changelog entry for this feature.
      # Continuwuity's startup log ALSO prints an unrelated later line containing the literal words
      # "registration token you" (a warning that the *configured* token won't work yet) — matching
      # on the one line that actually names the token, not just any "registration token" occurrence,
      # is what a naive grep got wrong the first time this was tested live.
      ESC="$(printf '\033')"
      BOOT_TOKEN="$(docker compose -f deploy/docker-compose.yml --profile matrix logs matrix 2>&1 \
        | grep -a 'Pick your own username' \
        | sed "s/${ESC}\[[0-9;]*m//g" \
        | sed -n 's/.*registration token \([A-Za-z0-9]*\) \..*/\1/p' \
        | tail -n1)"
      if [ -z "$BOOT_TOKEN" ]; then
        # Only printed while the homeserver has no accounts at all — so it already has some (an
        # earlier run's data volume), and the configured token is the one that works now.
        warn "This homeserver already has accounts, so @$ADMIN_LOCALPART is created as a regular
    user, not its admin. The first account ever registered on it is the admin."
        BOOT_TOKEN="$MATRIX_REGISTRATION_TOKEN"
      fi

      log "Creating your admin account (@$ADMIN_LOCALPART:$MATRIX_SERVER_NAME)"
      register_account "$ADMIN_LOCALPART" "$ADMIN_PASSWORD" "$BOOT_TOKEN"
      echo "  ok   $REGISTERED_USER_ID created — this is what you log into Purrlor with"
    fi

    if username_taken "$BOT_LOCALPART"; then
      die "@$BOT_LOCALPART:$MATRIX_SERVER_NAME already exists on this homeserver, but its access token isn't in .env (it was overwritten). Either re-run with a different bot local part, or reset its password from the admin room ('!admin users reset-password $BOT_LOCALPART') and put it in .env as MATRIX_BOT_USERNAME / MATRIX_BOT_PASSWORD."
    fi
    log "Creating the token server's bot account (@$BOT_LOCALPART:$MATRIX_SERVER_NAME)"
    register_account "$BOT_LOCALPART" "$BOT_PASSWORD" "$MATRIX_REGISTRATION_TOKEN"
    BOT_USER_ID="$REGISTERED_USER_ID"
    BOT_ACCESS_TOKEN="$REGISTERED_ACCESS_TOKEN"
    echo "  ok   $BOT_USER_ID created"

    env_set MATRIX_BOT_USER_ID "$BOT_USER_ID"
    env_set MATRIX_BOT_ACCESS_TOKEN "$BOT_ACCESS_TOKEN"
  fi

  # The token server reaches the homeserver over the compose network, not its public URL — no
  # round trip out through nginx (or the outbound proxy) and back in to a service on this host.
  env_set MATRIX_HOMESERVER_URL "http://matrix:8008"

  if [ "$MATRIX_REGISTRATION_MODE" = closed ]; then
    # Takes effect when the `up` below recreates the matrix container with the new value.
    env_set MATRIX_ALLOW_REGISTRATION false
    echo "  ok   registration will be closed once the stack restarts"
  fi
  echo "  ok   .env updated"
fi

log "Downloading and starting the rest of the Purrlor stack"
# Prebuilt images first (built by CI for amd64 and arm64 — seconds to download, no memory needed).
# Only if that fails (no internet to the registry, an unusual CPU) is it built here, which needs
# ~4 GB of memory: checked first, so a small server gets a clear message instead of a build killed
# halfway with "exit code 137".
if docker compose -f deploy/docker-compose.yml --env-file .env "${COMPOSE_PROFILE_ARGS[@]}" pull; then
  docker compose -f deploy/docker-compose.yml --env-file .env "${COMPOSE_PROFILE_ARGS[@]}" up -d
else
  warn "Couldn't download the prebuilt images — building them on this server instead."
  if [ $((MEM_MB + SWAP_MB)) -lt 3800 ]; then
    die "Building here needs about 4 GB of memory (RAM + swap) and this server has $((MEM_MB + SWAP_MB)) MB.
    Check this server can reach ghcr.io (the image registry), then re-run: sudo bash deploy/setup.sh"
  fi
  docker compose -f deploy/docker-compose.yml --env-file .env "${COMPOSE_PROFILE_ARGS[@]}" up -d --build
fi

log "Checking everything from the outside (the way a browser would)"

# check LABEL COMMAND... -> runs COMMAND a few times (services take a moment after `up`), prints
# ok/FAIL, and counts failures for the summary.
CHECK_FAILURES=0
check() {
  local __label="$1"; shift
  local __i
  for __i in 1 2 3 4 5 6 7 8 9 10; do
    if "$@" >/dev/null 2>&1; then echo "  ok   $__label"; return 0; fi
    sleep 3
  done
  echo "  FAIL $__label"
  CHECK_FAILURES=$((CHECK_FAILURES + 1))
  return 0
}
# Straight at this server, whatever the DNS cache on this box says, and never via the outbound
# proxy — this is checking the way in, not the way out. With nginx elsewhere, through real DNS.
public_get() {
  if [ "$EDGE_MODE" = true ]; then
    curl -fsS -m 10 --noproxy '*' "https://$1$2"
  else
    curl -fsS -m 10 --noproxy '*' --resolve "$1:443:$HOST_IP_VALUE" "https://$1$2"
  fi
}
# Captured first, not piped: with pipefail, grep -q quitting early can fail the pipeline.
body_has() { local __body; __body="$(public_get "$1" "$2")" && grep -q -- "$3" <<<"$__body"; }

if [ "$EDGE_MODE" = true ]; then
  check "web client answers on $LOCAL_ADDR:8080" curl -fsS -m 5 "http://$LOCAL_ADDR:8080/"
  check "token server answers on $LOCAL_ADDR:3001" curl -fsS -m 5 "http://$LOCAL_ADDR:3001/health"
  check "push gateway answers on $LOCAL_ADDR:3002" curl -fsS -m 5 "http://$LOCAL_ADDR:3002/health"
  check "voice server answers on $LOCAL_ADDR:7880" curl -fsS -m 5 "http://$LOCAL_ADDR:7880/"
  echo "  (the checks below go through your nginx server — they pass once its config is in place)"
fi
check "app loads at https://$APP_DOMAIN" public_get "$APP_DOMAIN" /
check "app knows its voice server and push gateway" body_has "$APP_DOMAIN" /config.json "$LIVEKIT_DOMAIN"
check "token server answers at /api/livekit" body_has "$APP_DOMAIN" /api/livekit/config botUserId
check "push gateway answers at /api/push" body_has "$APP_DOMAIN" /api/push/health ok
check "voice server answers at https://$LIVEKIT_DOMAIN" public_get "$LIVEKIT_DOMAIN" /
if [ "$PROVISION_MATRIX" = true ]; then
  check "homeserver answers at https://$MATRIX_DOMAIN" body_has "$MATRIX_DOMAIN" /_matrix/client/versions versions
  if [ "$MATRIX_DELEGATED" = true ]; then
    check "$BASE_DOMAIN points Matrix at $MATRIX_DOMAIN" body_has "$BASE_DOMAIN" /.well-known/matrix/server "$MATRIX_DOMAIN"
  fi
  if [ "$EDGE_MODE" = false ]; then
    check "federation port 8448 answers" curl -fsS -m 10 --noproxy '*' --resolve "$MATRIX_DOMAIN:8448:$HOST_IP_VALUE" "https://$MATRIX_DOMAIN:8448/_matrix/federation/v1/version"
  fi
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

if [ "$PROVISION_MATRIX" = true ]; then
  LOGIN_LINE="Log in as @$ADMIN_LOCALPART:$MATRIX_SERVER_NAME with the password you chose (it's the homeserver's admin)."
else
  LOGIN_LINE="Log in with your existing account on $HOMESERVER_URL."
fi

SIGNUP_NOTE=""
if [ "$PROVISION_MATRIX" = true ]; then
  if [ "$MATRIX_REGISTRATION_MODE" = token ]; then
    SIGNUP_NOTE="Inviting people: sign-up is invite-only. Give them this sign-up code (the register
screen asks for it):

    $MATRIX_REGISTRATION_TOKEN

To revoke it and make a new one:  purrlor new-invite-code"
  else
    SIGNUP_NOTE="Inviting people: sign-up is closed. Create accounts from the admin room in Purrlor
('!admin users create-user <name>'), or open invite-only sign-up with:  purrlor open-signups"
  fi
fi

EDGE_NOTE=""
if [ "$EDGE_MODE" = true ]; then
  EDGE_NOTE="Your nginx server: two files to add (they're in $REPO_ROOT/deploy/edge/):

  purrlor.conf         the sites — into its http {} config (e.g. /etc/nginx/conf.d/ or http.d/).
                       It expects a certificate at /etc/letsencrypt/live/$APP_DOMAIN/ covering:
                         ${DNS_CHECK_DOMAINS[*]}
                       Get one there with:  certbot certonly --nginx --cert-name $APP_DOMAIN $(printf -- '-d %s ' "${DNS_CHECK_DOMAINS[@]}")
                       (or change the ssl_certificate lines to where your certificates already are)
  purrlor-stream.conf  voice/video media relay — Alpine: into /etc/nginx/stream.d/ (after
                       apk add nginx-mod-stream); Debian/Ubuntu: see the note at the top of the file

Then 'nginx -t && nginx -s reload' there, open 7881/tcp and 7882/udp on it (and 8448/tcp for
federation), make sure it can reach $LOCAL_ADDR on 8080, 3001, 3002, 7880 and 8008, and run
'purrlor doctor' here to check it all from the outside."
fi

FAIL_NOTE=""
if [ "$CHECK_FAILURES" -gt 0 ] && [ "$EDGE_MODE" = false ]; then
  FAIL_NOTE="
!! $CHECK_FAILURES check(s) above failed. Usual causes: a DNS record that isn't pointing here yet,
!! or your provider's firewall blocking a port. See what's wrong with:  purrlor doctor
"
fi

SUMMARY_TEXT="Purrlor is installed.

Open:     https://$APP_DOMAIN
$LOGIN_LINE

Voice/video and notifications are already set up for every space created here — nothing to
configure in the app.

$EDGE_NOTE

$SIGNUP_NOTE

Managing it (from anywhere on this server):
  purrlor status          what's running, and whether it's healthy
  purrlor logs [service]  follow the logs (web, token-server, push-gateway, livekit, matrix)
  purrlor update          get the latest Purrlor and restart onto it
  purrlor backup          save .env and the homeserver's data to a file
  purrlor doctor          re-run the outside-in checks above

Installed in: $REPO_ROOT   (settings: $REPO_ROOT/.env)"

# Kept for later — `purrlor info` prints it again. Mode 600: it holds the sign-up code.
printf '%s\n' "$SUMMARY_TEXT" > "$REPO_ROOT/.install-summary"
chmod 600 "$REPO_ROOT/.install-summary"

# The `purrlor` management command.
ln -sf "$REPO_ROOT/deploy/purrlor" /usr/local/bin/purrlor
chmod +x "$REPO_ROOT/deploy/purrlor"

printf '%s\n' "$FAIL_NOTE"
printf '\n============================================================================\n\n'
printf '%s\n' "$SUMMARY_TEXT"
printf '\n(This summary is saved — see it again any time with: purrlor info)\n'
