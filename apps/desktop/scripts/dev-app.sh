#!/usr/bin/env bash
# Launch an isolated DEV instance of the desktop app so it coexists with an
# installed build: its own data dir (~/.yaac-dev), k8s namespace (yaac-dev),
# server port (8788), and Electron storage/name ("yaac (dev)"). Runs Vite for
# frontend HMR alongside Electron and tears Vite down on exit.
set -u
cd "$(dirname "$0")/.."

export YAAC_DATA_DIR="$HOME/.yaac-dev"
export YAAC_SERVER_PORT=8788
export YAAC_K8S_NAMESPACE="yaac-dev"
export YAAC_BUILD_ID="dev"

pnpm build || exit 1

# Vite proxies to the dev server (fixed port above, so no start-order race).
pnpm --filter @yaac/frontend dev >/tmp/yaac-dev-vite.log 2>&1 &
VITE=$!
trap 'kill "$VITE" 2>/dev/null' EXIT
for _ in $(seq 1 40); do
  curl -sf http://localhost:1420/ >/dev/null 2>&1 && break
  sleep 0.25
done

YAAC_DESKTOP_DEV=1 YAAC_DESKTOP_RENDERER_URL=http://localhost:1420/ pnpm exec electron .
