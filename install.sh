#!/usr/bin/env bash
# Purrlor one-line installer. On a fresh Debian or Ubuntu server:
#
#   curl -fsSL https://raw.githubusercontent.com/m0nnnna/Purrlor/master/install.sh | sudo bash
#
# It installs git if needed, puts Purrlor in /opt/purrlor (or updates it, if it's already there),
# and starts the guided setup (deploy/setup.sh), which asks a few questions and does the rest.
# Set PURRLOR_DIR or PURRLOR_BRANCH to change where it goes or which branch it follows.

set -euo pipefail

REPO_URL="${PURRLOR_REPO:-https://github.com/m0nnnna/Purrlor.git}"
DIR="${PURRLOR_DIR:-/opt/purrlor}"
BRANCH="${PURRLOR_BRANCH:-master}"

echo
echo "  Purrlor installer"
echo "  -----------------"
echo

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run it as root:  curl -fsSL https://raw.githubusercontent.com/m0nnnna/Purrlor/master/install.sh | sudo bash" >&2
  exit 1
fi
if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer supports Debian and Ubuntu. On other systems, follow docs/deployment.md." >&2
  exit 1
fi

# The setup asks questions. Piped from curl, this script's stdin is the script itself, so the
# answers have to come from the terminal instead.
if [ ! -r /dev/tty ]; then
  echo "No terminal to ask questions on — run this from an interactive SSH session." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo "==> Installing git and curl"
  apt-get update -qq
  apt-get install -y -qq git curl ca-certificates >/dev/null
fi

if [ -d "$DIR/.git" ]; then
  echo "==> Purrlor is already in $DIR — updating it"
  git -C "$DIR" fetch --quiet origin "$BRANCH"
  git -C "$DIR" checkout --quiet "$BRANCH"
  git -C "$DIR" pull --ff-only --quiet origin "$BRANCH"
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  echo "$DIR exists and isn't a Purrlor checkout. Move it aside, or set PURRLOR_DIR to install elsewhere." >&2
  exit 1
else
  echo "==> Downloading Purrlor into $DIR"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$DIR"
fi

echo "==> Starting the guided setup"
exec bash "$DIR/deploy/setup.sh" </dev/tty
