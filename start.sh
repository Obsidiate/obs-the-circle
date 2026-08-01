#!/usr/bin/env bash
# Double-clickable launcher. Start this before OBS — it serves the overlay.
cd "$(dirname "$0")" || exit 1
[ -d node_modules ] || npm install
exec node server/index.js
