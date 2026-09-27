# Builds the Purrlor web client into a static bundle and serves it with nginx.
#
# No runtime config injection (unlike cinny-voice's Dockerfile.voice, which baked a single
# global LiveKit URL/token endpoint into the served page): Purrlor discovers voice server config
# per-Space from Matrix room state (xyz.nekous.voice_server, see docs/voice-architecture.md),
# and the homeserver is whatever URL the user enters at login — this same built bundle can be
# pointed at any homeserver, or serve multiple Spaces each with their own LiveKit deployment,
# without a rebuild.
#
# The one per-deployment setting, PURRLOR_HOMESERVER_URL (locks the login screen to a single
# homeserver), is read at container START, not build time: deploy/40-purrlor-config.sh writes it
# into /config.json, which the client fetches on load. Still one image for every deployment.

FROM --platform=$BUILDPLATFORM node:24-alpine AS builder
WORKDIR /src

COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci

COPY apps/web ./
ENV NODE_OPTIONS=--max_old_space_size=4096
RUN npm run build


FROM nginx:1.25-alpine
COPY --from=builder /src/dist /usr/share/nginx/html
COPY apps/web/deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 apps/web/deploy/40-purrlor-config.sh /docker-entrypoint.d/40-purrlor-config.sh

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
