#!/bin/sh
# Purrlor one-line installer, for a fresh Alpine, Debian or Ubuntu server.
#
#   Alpine (as root):   wget -qO- https://raw.githubusercontent.com/m0nnnna/Purrlor/master/install.sh | sh
#   Debian / Ubuntu:    curl -fsSL https://raw.githubusercontent.com/m0nnnna/Purrlor/master/install.sh | sudo sh
#
# It installs what the setup needs to start (git, bash, curl), puts Purrlor in /opt/purrlor (or
# updates it, if it's already there), and starts the guided setup (deploy/setup.sh), which asks a
# few questions and does the rest. Set PURRLOR_DIR or PURRLOR_BRANCH to change where it goes or
# which branch it follows.
#
# Plain POSIX sh on purpose: a stock Alpine has no bash until this installs it.

set -eu

REPO_URL="${PURRLOR_REPO:-https://github.com/m0nnnna/Purrlor.git}"
DIR="${PURRLOR_DIR:-/opt/purrlor}"
BRANCH="${PURRLOR_BRANCH:-master}"

echo
echo "  Purrlor installer"
echo "  -----------------"
echo

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run it as root — on Alpine, as root (or with doas); on Debian/Ubuntu, with sudo:" >&2
  echo "  wget -qO- https://raw.githubusercontent.com/m0nnnna/Purrlor/master/install.sh | sh" >&2
  exit 1
fi

# The setup asks questions. Piped from wget/curl, this script's stdin is the script itself, so the
# answers have to come from the terminal instead.
if ! { : </dev/tty; } 2>/dev/null; then
  echo "No terminal to ask questions on — run this from an interactive SSH session." >&2
  exit 1
fi

if command -v apk >/dev/null 2>&1; then
  missing=""
  for cmd in git bash curl; do command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"; done
  if [ -n "$missing" ]; then
    echo "==> Installing$missing"
    # shellcheck disable=SC2086 # one word per package, on purpose
    apk add --no-cache $missing ca-certificates >/dev/null
  fi
elif command -v apt-get >/dev/null 2>&1; then
  if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
    echo "==> Installing git and curl"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates >/dev/null
  fi
else
  echo "This installer supports Alpine, Debian and Ubuntu. On other systems, follow docs/deployment.md." >&2
  exit 1
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
