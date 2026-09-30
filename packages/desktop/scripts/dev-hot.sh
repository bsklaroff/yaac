#!/usr/bin/env bash
# Run the desktop shell with frontend hot-reload. Unlike `desktop:dev`, which
# loads the SPA the server serves, this points the window at the Vite dev
# server (:1420) via YAAC_DESKTOP_RENDERER_URL. It uses the same ~/.yaac server
# and state as an installed app. Main-process (src/*.ts) changes still need a
# restart of this script.
set -u
cd "$(dirname "$0")/.."

# Build the main process once; the renderer comes from Vite.
pnpm exec tsup || exit 1

# Best-effort: a version-skewed server fails the start but stays registered in
# server.json, which is where Vite's proxy finds it.
yaac server start || true

# Start Vite first and wait for it, so the window has something to load.
# `set -m` puts it in its own process group so the trap can kill all of it:
# $! is only the pnpm wrapper, and killing that alone leaves vite holding
# :1420. stdin is /dev/null because a background group that reads the
# terminal is stopped by SIGTTIN.
set -m
pnpm --filter @yaac/frontend dev </dev/null >/tmp/yaac-hot-vite.log 2>&1 &
VITE=$!
set +m
trap 'kill -- -"$VITE" 2>/dev/null' EXIT
for _ in $(seq 1 40); do
  curl -sf http://localhost:1420/ >/dev/null 2>&1 && break
  sleep 0.25
done

YAAC_DESKTOP_RENDERER_URL=http://localhost:1420/ pnpm exec electron .
