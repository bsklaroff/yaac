---
name: run-yaac
description: Build, run, and drive yaac — the agent-sandbox manager (the `yaac` CLI plus its local web app). Use to start the yaac server, screenshot or interact with the web app, drive `yaac` CLI commands, build it, or run its tests.
---

yaac runs each agent session on one of two substrates: a Kubernetes Job
(`k8s`) or a tmux server on the host (`containerless`). Two surfaces are
worth driving — the **web app** (Playwright driver at
`.claude/skills/run-yaac/driver.mjs`) and the **CLI** (`yaac <cmd>`). Paths
below are relative to the repo root.

## Where am I running?

This decides what you may touch. It is **not** what `/health` reports — that
says which driver the server *inside* this worktree runs, not what kind of
place this worktree is.

```bash
[ -d /etc/yaac/certs ] && echo container || echo host
```

That dir is the proxy CA the k8s pod spec mounts unconditionally; a host
worktree has no proxy to trust. (`YAAC_STREAM_TOKEN` says the same but is
weaker — the containerless driver strips every `YAAC_*`, so a worktree of an
inner containerless server sees no token while still on the pod's
filesystem. **On disagreement, believe the dir.**)

- **container** — a k8s worktree pod (directly, or in a worktree of a
  containerless server inside one). No cluster in here and no `kubectl`, so
  `yaac cluster *` has nothing to talk to; only a **containerless** install
  is supported. `yaac host check` is the local check. You are already
  isolated: drive the inner server and mutate it freely.
- **host** — a real machine. Its `kubectl`/`podman`/`kind` are on your PATH
  and point at **the developer's own install** (`~/.yaac`, their worktrees,
  their `:8787`). Nothing is isolated for you — see **Testing against a
  second yaac** before mutating anything.

## The server

One may already be running — this repo's `yaac-config.json` starts one, but
do not assume it succeeded or is still up. Check:

```bash
curl -s http://127.0.0.1:8787/health   # -> {"ok":true,"buildId":...,"ready":true,"driver":...}
```

If nothing answers, start it. In a **container** name the driver, since a
data dir with nothing recorded defaults to `k8s`, which cannot work here:

```bash
yaac server start --driver containerless   # container
yaac server start                          # host: honors the recorded driver
```

Subcommands: `start|stop|restart|logs` — there is no `status`; use `/health`
or `$YAAC_DATA_DIR/.server.lock`.

**A live server does not follow your edits.** It serves whatever `dist/` held
when it started, and nothing rebuilds unless you run `pnpm watch` yourself.
After changing server or frontend source: `pnpm build && yaac server restart`
— or run `pnpm watch` in the background, which does both on every change. If
a fix "does nothing", check `/health`'s buildId before and after.

## Build

```bash
pnpm build   # tsup CLI + vite frontend + copies dockerfiles/k8s/drizzle; ~7s
```

The buildId is a content hash, so an unchanged tree yields the same id and
the live server is not bounced — which is also why a rebuild alone never
reaches it.

## Drive — web app

The driver does `yaac open`'s token→cookie handshake against the running
server in headless Chromium, reading port + secret from
`$YAAC_DATA_DIR/.server.lock` (falls back to `~/.yaac`).

```bash
node .claude/skills/run-yaac/driver.mjs shot                     # -> /tmp/yaac-shots/app.png
node .claude/skills/run-yaac/driver.mjs shot skills --click '[aria-label="Skills"]'
node .claude/skills/run-yaac/driver.mjs eval 'document.title'    # JS against the live DOM
node .claude/skills/run-yaac/driver.mjs open                     # load + report URL/title
```

**Open the screenshot and look at it** — a blank frame means load or auth
failed. Flags (any command): `--goto <path>`, `--click <sel>`,
`--wait <sel>`, `--url <origin>`, `--settle <ms>` (default 3000), `--full`.
Selectors are Playwright (`text=New session`, CSS, `[aria-label=…]`).

Each run is a fresh browser with a fresh one-time token — nothing carries
between runs, so reach an interior view *and* shoot it in one command.

## Drive — CLI

```bash
yaac project list                 # seeded env has one project: "yaac"
yaac worktree list
yaac auth list                    # masked
yaac open --no-browser            # prints the tokenized URL
```

Full reference: `README.md` (`## CLI`). `yaac worktree create <project>`
attaches to the session's tmux and never exits — from a script, expect to
kill or timeout it (the session is fine) and clean up with `yaac worktree
stop <id>`.

## Test

```bash
pnpm lint                       # tsc x2 + eslint — the single typecheck entry point
pnpm exec vitest run <file>     # one file
pnpm test:unit                  # all co-located unit suites
pnpm test:api-containerless     # route matrix, containerless column; no cluster
pnpm exec vitest run --project e2e-containerless
```

The k8s tiers (`test:e2e`, `test:e2e-cli`, `test:api-k8s`) need a wired
cluster. **In a container they cannot run** — say so plainly rather
than implying coverage you could not get. On the **host** they run against
whatever cluster `kubectl` points at, isolating their objects in per-run
namespaces. Either way run a targeted file, not the whole suite.

## Testing against a second yaac

**Host only.** In a container the inner server *is* your sandbox.

On the host, a bare `yaac server start` drives the developer's install. Check
first whether a test cluster and instance already exist — reuse beats
building:

```bash
env | grep ^YAAC_                       # already exported for a test instance?
kind get clusters                       # a test cluster beside the developer's?
curl -s http://127.0.0.1:${YAAC_SERVER_PORT:-8890}/health
```

If they are set and answering, use them as-is. Otherwise export the whole set
— **for every `yaac` call**, since the CLI finds its server through the
`.server.lock` in `YAAC_DATA_DIR`:

| Variable | Why |
|---|---|
| `YAAC_DATA_DIR` | The install identity (hashed into the cluster label and cookie name). For k8s put it under `$HOME`, never `/tmp`: pods hostPath-mount paths beneath it and those resolve on the NODE, where kind maps only `$HOME`. |
| `YAAC_SERVER_PORT` | Clear of 8787 — the probe walks 8787→8850 and would land beside the real server. |
| `YAAC_K8S_NAMESPACE` | k8s only. Scopes proxy, netd, worktree Jobs, per-project registries. |
| `YAAC_KIND_CLUSTER` | k8s only. A cluster of its own, so setup never touches the developer's. |
| `KUBECONFIG` | k8s only. A separate file, so creating the test cluster does not repoint the developer's default context — their server follows it. |

**Containerless** — no cluster needed:

```bash
export YAAC_DATA_DIR=/tmp/yaac-dev-$$ YAAC_SERVER_PORT=8890
yaac server start --driver containerless
```

**k8s** — its own cluster:

```bash
export YAAC_DATA_DIR="$HOME/.yaac-dev" YAAC_SERVER_PORT=8890 \
       YAAC_K8S_NAMESPACE=yaac-dev YAAC_KIND_CLUSTER=yaac-dev \
       KUBECONFIG="$HOME/.kube/yaac-dev.config"
yaac cluster setup && yaac cluster check
yaac server start --driver k8s
```

Never run `cluster setup`/`delete` without `YAAC_KIND_CLUSTER` pointed at a
test cluster: the default name is the developer's, and both recreate or
destroy it.

**Credentials:** copy them from the host install — do not read, print or
reconstruct them, and do not use `yaac auth fake` (its placeholders are
swapped by a *parent* yaac's proxy, and on the host there is nothing above
you, so they reach the real API unswapped and fail).

```bash
mkdir -p "$YAAC_DATA_DIR" && cp -r ~/.yaac/.credentials "$YAAC_DATA_DIR"/
```

No restart needed — the proxy reads that dir per request, and a
containerless create reads it at create time.

**Tear down** — worktrees are real processes and pods:

```bash
yaac worktree list && yaac worktree stop <id>   # each, env still exported
yaac server stop
kubectl delete namespace "$YAAC_K8S_NAMESPACE" --ignore-not-found   # k8s
rm -rf "$YAAC_DATA_DIR"
```

Namespace before the data dir: pods mounting paths that vanish under them
hang.

## Gotchas

- **On the host, `yaac` with no `YAAC_DATA_DIR` drives the DEVELOPER'S
  install** — every mutating command lands there.
- **In a container `yaac cluster *` is not the tool** — no cluster, no
  `kubectl`. `yaac host check` is the local check.
- **The web app auto-selects the single seeded project** (`?project=yaac`);
  an empty install lands on a picker instead.
- **`image-prewarm … ENOENT: dist/dockerfiles/Dockerfile.default`** in
  `server.log` just means `dist/` is not populated yet — `pnpm build`.

## Troubleshooting

- **`no .server.lock found`** — no server up; start it, then retry.
- **Playwright `Executable doesn't exist`** — export
  `PLAYWRIGHT_BROWSERS_PATH` (driver defaults to `/opt/playwright-browsers`).
- **`token mint failed: HTTP 401`** — stale lock secret; confirm
  `.server.lock` matches the live server via `/health`'s buildId.
- **Blank/half-rendered screenshot** — raise `--settle` or add `--wait
  <selector>` for a marker in the view.
