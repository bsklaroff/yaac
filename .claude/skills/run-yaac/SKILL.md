---
name: run-yaac
description: Build, run, and drive yaac — the agent-sandbox manager (the `yaac` CLI plus its local web app). Use to start the yaac server, screenshot or interact with the web app, drive `yaac` CLI commands, build it, or run its tests.
---

yaac is the `yaac` CLI plus a server that serves the web app and runs
workspaces on one of two substrates: **k8s** (server and workspaces are pods in
a local kind cluster, set up by `yaac cluster install`) or **containerless**
(server is a host process started by `yaac server start`; workspaces are host
tmux servers). Paths below are relative to the repo root.

This assumes a normal host. **If `/etc/yaac/certs` exists you are inside a
yaac workspace pod** — skip to [Inside a yaac workspace](#inside-a-yaac-workspace).

## Set up and run

Prerequisites (node via nvm, pnpm, podman, kind, kubectl; tmux, socat, fd,
ripgrep for containerless) are in `README.md` → "From source". Then:

```bash
pnpm install && pnpm build        # CLI + SPA + assets into dist/, ~7s
npm install -g .                  # links `yaac` here; `brew uninstall yaac-server` first

yaac cluster install && yaac cluster check   # k8s: cluster + server pod (data dir ~/.yaac-cluster)
yaac host check && yaac server start         # and/or containerless: host process (~/.yaac)
```

The user normally adds credentials and projects from the app.

If `yaac` on PATH is some other build (`readlink -f "$(which yaac)"` is not
this checkout's `dist/cli.js`), run `node dist/cli.js <cmd>` instead.

**A running server does not follow your edits** — it serves the `dist/` it
started from. After changing source: `pnpm build`, then `yaac server restart`
(containerless) or `yaac cluster install` (k8s: rebuilds the server image
from `dist/` and rolls the pod). `pnpm watch` does build + restart on every
change for a containerless server. If a fix "does nothing", compare
`/health`'s `buildId` before and after.

## A second instance beside an existing one

With no `YAAC_DATA_DIR`, `yaac server …` drives the host install in
`~/.yaac` and `yaac cluster …` the cluster install in `~/.yaac-cluster` (its
kind cluster named `yaac`, published on port 8790), both registered in
`~/.yaac-client/server.json`. When that is the user's working
setup and you are testing rather than setting it up, leave it alone and run
a second instance. Check whether one already exists first
(`env | grep ^YAAC_ ; kind get clusters`); otherwise export these **in every
shell that runs `yaac`, `pnpm frontend:dev` or `desktop:hot`** — each finds
its server through `$YAAC_DATA_DIR-client/server.json`, so it is the data
dir, not the port, that steers them:

```bash
# containerless
export YAAC_DATA_DIR="$HOME/.yaac-dev" YAAC_SERVER_PORT=8890
yaac server start

# k8s — its own kind cluster, kubeconfig and namespace
export YAAC_DATA_DIR="$HOME/.yaac-dev" YAAC_SERVER_PORT=8890 \
       YAAC_KIND_CLUSTER=yaac-dev YAAC_K8S_NAMESPACE=yaac-dev \
       KUBECONFIG="$HOME/.kube/yaac-dev.config"
yaac cluster install && yaac cluster check
```

- `YAAC_SERVER_PORT` keeps clear of the first instances' `8787` and `8790`
  (for k8s it is the host port the server is published on).
- With `YAAC_DATA_DIR` set, `yaac server …` and `yaac cluster …` share that
  one dir, so it holds one install of either kind.
- Keep the k8s data dir under `$HOME`, never `/tmp`: pods hostPath-mount
  paths beneath it, and kind maps only `$HOME` onto the node.
- Never run `yaac cluster install|delete` here without `YAAC_KIND_CLUSTER`
  set — the default name is the existing install's cluster.
- The new instance starts with no credentials; the UI and most commands
  don't need them. `yaac auth fake` placeholders are swapped only by a
  parent yaac's proxy, so on a bare host they reach the real API unswapped.

**Tear down** (env still exported) — workspaces are real processes and pods:

```bash
yaac workspace list        # then `yaac workspace stop <id>` for each
yaac server stop              # containerless
yaac cluster delete --yes     # k8s: deletes the YAAC_KIND_CLUSTER cluster
rm -rf "$YAAC_DATA_DIR" "$YAAC_DATA_DIR-client"
```

## Check the server

```bash
yaac remote status                    # the origin this install's clients dial
curl -s <that origin>/health          # {"ok":true,"buildId":…,"ready":true,"driver":…}
```

`yaac server start|stop|restart|status|logs` for the host server, `yaac cluster start|stop|restart|status|logs` for the cluster's; both `status --json` are what the desktop tray reads.

## Drive the web app

`driver.mjs` loads the origin `server.json` selects (so it follows
`YAAC_DATA_DIR`) in headless Chromium — no credential, since a loopback
origin is this machine's owner:

```bash
node .claude/skills/run-yaac/driver.mjs shot                  # -> /tmp/yaac-shots/app.png
node .claude/skills/run-yaac/driver.mjs shot skills --click '[aria-label="Skills"]'
node .claude/skills/run-yaac/driver.mjs eval 'document.title'
```

Flags: `--goto <path>`, `--click <sel>`, `--wait <sel>`, `--settle <ms>`
(default 3000), `--full`. Selectors are Playwright (`text=…`, CSS,
`[aria-label=…]`). Each run is a fresh browser, so reach a view *and* shoot
it in one command. **Look at the screenshot** — a blank frame means load or
auth failed; raise `--settle` or add `--wait` for a half-rendered one.

## Drive the CLI

`yaac project list`, `yaac workspace list`, `yaac auth list` (masked); full
reference in `README.md` `## CLI`. `yaac workspace create <project>` attaches
to the session's tmux and never exits — from a script, time it out (the
workspace survives) and clean up with `yaac workspace stop <id>`.

## Test

```bash
pnpm lint                                   # the one typecheck entry point
pnpm vitest run --project unit:server <file>
pnpm test:api-containerless                 # no cluster needed
pnpm vitest run --project e2e-containerless
pnpm test:api-k8s / test:e2e / test:e2e-cli # need a cluster (below)
```

The k8s tiers run against whatever cluster `kubectl` points at, isolating
their objects in per-run namespaces. Run a targeted file, not the whole suite.

## Inside a yaac workspace

When `/etc/yaac/certs` exists you are in a k8s workspace pod (directly, or in a
workspace of a containerless server inside one). That changes three things:

- **You are already isolated.** The server this repo's `yaac-config.json`
  starts is yours — check `curl -s http://127.0.0.1:8787/api/health`, run
  `yaac server start` if it is down, and mutate it freely. No second
  instance is needed.
- **Only containerless works.** There is no cluster and no `kubectl`, so
  `yaac cluster *` has nothing to talk to (`yaac host check` is the local
  check), and the k8s test tiers cannot run — say so plainly rather than
  implying coverage you did not get.
- **`yaac auth fake <kinds…>` is how to get credentials** — the outer yaac's
  proxy swaps its placeholders for real ones.
