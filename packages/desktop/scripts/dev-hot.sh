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

# Ensure the shared server is up. Vite's proxy finds it through server.json,
# which `yaac server start` (or `yaac cluster install`) already registered.
# Best-effort: a skewed server fails the start but keeps its selection.
yaac server start || true

# Vite serves the SPA with HMR and proxies the API + WS back to the server (the
# same server.json selection the window resolves). Start it first and wait, so
# the window has something to load when the boot flow finishes.
#
# `set -m` gives it a process group of its own, and the trap kills that whole
# group: $! is only the pnpm wrapper, and killing it alone leaves vite
# re-parented to init and still holding :1420. stdin is /dev/null because a
# background group that reads the terminal is stopped by SIGTTIN.
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
