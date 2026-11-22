#!/bin/sh
# OpenDrillinAIR: install the brain. Safe to run again after `git pull`.
set -e
cd "$(dirname "$0")"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing $1. $2"; exit 1; }; }
need git "Install it with: xcode-select --install"
need node "Install Node.js 22 or newer from https://nodejs.org (or: brew install node)"
need npm "It comes with Node.js: https://nodejs.org"

major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 22 ]; then
  echo "Node $(node -v) found. The brain runs on it, but her voice and ears need Node 22 or newer."
  echo "Install a newer Node (https://nodejs.org) or set BRAIN_TTS_NODE to one. Continuing."
fi

echo "Installing the brain's packages…"
(cd brain && npm install --no-audit --no-fund)

if ! command -v claude >/dev/null 2>&1; then
  echo
  echo "Claude Code isn't installed yet. Get it at https://claude.com/claude-code and sign in."
fi

cat <<'MSG'

Ready. Next:
  1. In this folder run:  claude
  2. Allow the drillin-body server when asked, then type:  /soul
  3. On the iPhone: Drillin AIR → Settings → Characters' mind → on (same Wi-Fi).
The mind's galaxy: http://localhost:8788
MSG
