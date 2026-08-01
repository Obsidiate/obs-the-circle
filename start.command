#!/usr/bin/env bash
# The Circle — double-click me on macOS. Start before OBS; leave the window open.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js isn't installed — it's the only thing The Circle needs."
  echo ""
  echo "  Get the LTS installer from   https://nodejs.org"
  echo "  then double-click this file again."
  echo ""
  read -r -p "  Press Enter to close."
  exit 1
fi

# Releases ship node_modules, so this only runs for a git clone.
[ -d node_modules ] || npm install --omit=dev

node server/index.js
echo ""
read -r -p "  The Circle has stopped. Press Enter to close."
