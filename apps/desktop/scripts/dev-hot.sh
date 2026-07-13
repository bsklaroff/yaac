#!/usr/bin/env bash
# Dev the desktop shell WITH frontend hot-reload. Unlike `desktop:dev` (which
# loads the SPA the resolved server serves, so frontend edits need a rebuild),
# this points the Electron window at the Vite dev server (:1420) via
# YAAC_DESKTOP_RENDERER_URL, so frontend edits hot-reload live. It sets no data
# dir / port / namespace / identity overrides, so it shares the same ~/.yaac
# server and state as an installed app. Only the RENDERER hot-reloads;
# main-process (src/*.ts) changes still need a restart of this script.
set -u
cd "$(dirname "$0")/.."

# Build the main process once (the window's renderer comes from Vite, not
# dist/, so dist/frontend is irrelevant here).
pnpm exec tsup || exit 1

# Ensure the shared server is up so Vite reads its real port from the lock.
# Best-effort and idempotent: `server start` no-ops if already running, and a
# live-but-version-skewed server still leaves a correct lock for Vite to read.
yaac server start || true

# Vite serves the SPA with HMR and proxies the API + WS back to the server (it
# reads the same ~/.yaac/.server.lock). Start it first and wait, so the window
# has something to load when the boot flow finishes.
pnpm --filter @yaac/frontend dev >/tmp/yaac-hot-vite.log 2>&1 &
VITE=$!
trap 'kill "$VITE" 2>/dev/null' EXIT
for _ in $(seq 1 40); do
  curl -sf http://localhost:1420/ >/dev/null 2>&1 && break
  sleep 0.25
done

YAAC_DESKTOP_RENDERER_URL=http://localhost:1420/ pnpm exec electron .
