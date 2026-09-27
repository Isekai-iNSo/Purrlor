#!/bin/sh
# Updates this production deployment from images/configs built elsewhere and dropped onto a
# shared mount (Windows dev machine's Y:\nekous-deploy, mounted here at $SOURCE_DIR) — the
# "build on a real dev machine, ship the image, don't rebuild on the small production box" flow
# docker-compose.yml's own top comment refers to. Run this ON the production machine itself,
# as a user with docker permissions:
#
#   sh /opt/nekous/deploy/update-from-mount.sh
#
# What it does, in order:
#   1. Copies the current deploy/docker-compose.yml and deploy/livekit.yaml from the mount into
#      /opt/nekous/deploy/ — NOT .env (that holds this deployment's real secrets and is never
#      touched here) and NOT the nginx/ examples (static reference files, not loaded by anything).
#   2. `docker load`s the three prebuilt images (web, token-server, push-gateway) straight from
#      the mount — no need to duplicate multi-hundred-MB tarballs onto local disk just to load
#      them once.
#   3. Recreates the compose stack from those freshly loaded `:latest`-tagged images (no
#      `--build` — see docker-compose.yml's comment on why a plain `up -d` picks up a loaded
#      image without rebuilding).
#
# Safe to re-run. Does not touch livekit's own persisted state, .env, or anything under
# /etc/letsencrypt. Does not prune old images afterward — do that by hand
# (`docker image prune -f`) once you've confirmed the new containers are healthy.

set -eu

SOURCE_DIR="${SOURCE_DIR:-/mnt/deploy/nekous-deploy}"
DEST_DIR="${DEST_DIR:-/opt/nekous}"

if [ ! -d "$SOURCE_DIR" ]; then
  echo "error: source mount not found at $SOURCE_DIR (is the share actually mounted?)" >&2
  exit 1
fi

if [ ! -d "$DEST_DIR" ]; then
  echo "error: $DEST_DIR does not exist — this script updates an existing deployment, it does not set one up from scratch (see docs/deployment.md for that)" >&2
  exit 1
fi

if [ ! -f "$DEST_DIR/.env" ]; then
  echo "error: $DEST_DIR/.env is missing — refusing to bring the stack up without it" >&2
  exit 1
fi

for f in purrlor-web.tar purrlor-token-server.tar purrlor-push-gateway.tar deploy/docker-compose.yml deploy/livekit.yaml; do
  if [ ! -f "$SOURCE_DIR/$f" ]; then
    echo "error: expected file missing from mount: $SOURCE_DIR/$f" >&2
    exit 1
  fi
done

echo "==> copying deploy config"
mkdir -p "$DEST_DIR/deploy"
cp "$SOURCE_DIR/deploy/docker-compose.yml" "$DEST_DIR/deploy/docker-compose.yml"
cp "$SOURCE_DIR/deploy/livekit.yaml" "$DEST_DIR/deploy/livekit.yaml"
# Keep a copy of this script itself at a stable path, so future runs don't depend on remembering
# where on the mount it originally came from.
cp "$0" "$DEST_DIR/deploy/update-from-mount.sh" 2>/dev/null || true

echo "==> loading images"
docker load -i "$SOURCE_DIR/purrlor-web.tar"
docker load -i "$SOURCE_DIR/purrlor-token-server.tar"
docker load -i "$SOURCE_DIR/purrlor-push-gateway.tar"

echo "==> recreating containers"
cd "$DEST_DIR"
# Plain local image names (purrlor-web:latest, ...) — what the `docker load` above provides —
# rather than the registry ones compose uses by default.
PURRLOR_IMAGE_PREFIX='' docker compose -f deploy/docker-compose.yml --env-file .env up -d --force-recreate web token-server push-gateway

echo "==> done"
docker compose -f deploy/docker-compose.yml ps
