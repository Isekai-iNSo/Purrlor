#!/bin/sh
# Writes the web client's per-deployment config (apps/web/src/app/runtimeConfig.ts) from this
# container's environment. The nginx image runs every executable /docker-entrypoint.d/*.sh before
# starting nginx, so this happens on each container start — changing these in .env and recreating
# the container is enough, no image rebuild.
#
#   PURRLOR_HOMESERVER_URL    locks the login and register screens to one homeserver
#   PURRLOR_LIVEKIT_URL       } this deployment's voice server, given to Spaces that don't have
#   PURRLOR_TOKEN_ENDPOINT    } one yet (apps/web/src/matrix/deploymentDefaults.ts)
#   PURRLOR_PUSH_GATEWAY_URL  this deployment's push gateway, the default for notifications
#
# Any of them unset or empty is written as "", which the client reads as "not set": it then
# behaves as a general-purpose client and asks for that setting instead.
set -eu

# Escape the two characters that could break out of a JSON string. Everything else a URL or
# server name can contain is fine as-is.
json() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

printf '{"homeserver":"%s","livekitUrl":"%s","tokenEndpoint":"%s","pushGateway":"%s"}\n' \
  "$(json "${PURRLOR_HOMESERVER_URL:-}")" \
  "$(json "${PURRLOR_LIVEKIT_URL:-}")" \
  "$(json "${PURRLOR_TOKEN_ENDPOINT:-}")" \
  "$(json "${PURRLOR_PUSH_GATEWAY_URL:-}")" \
  > /usr/share/nginx/html/config.json

echo "purrlor: wrote config.json (homeserver: ${PURRLOR_HOMESERVER_URL:-<not locked>}," \
  "voice: ${PURRLOR_LIVEKIT_URL:-<per space>}, push: ${PURRLOR_PUSH_GATEWAY_URL:-<per account>})"
