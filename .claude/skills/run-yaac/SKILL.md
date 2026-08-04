---
name: run-yaac
description: Build, run, and drive yaac — the agent-sandbox manager (the `yaac` CLI plus its local web app). Use to start the yaac server, screenshot or interact with the web app, drive `yaac` CLI commands, build it, or run its tests.
---

yaac is an "agent sandbox manager": a `yaac` CLI that drives a local HTTP/WS
server, which serves a React web app and runs each agent session as a
Kubernetes Job. Two surfaces are worth driving: the **web app** (screenshot /
DOM-inspect it with the Playwright driver at
`.claude/skills/run-yaac/driver.mjs`) and the **CLI** (run `yaac <cmd>`
directly). All paths below are relative to the repo root.

This repo is normally worked on **inside a nested yaac dev session**
(`YAAC_NESTED=1`), where the toolchain and cluster come pre-wired (see
Environment). The server is usually already running — you mostly *drive* it,
not stand it up.

## Environment

An agent working in this repo lands in a container that already has: Node 22,
`pnpm` 11, `kubectl`, `podman`, `tsx`, Playwright (global `npm` root, Chromium
under `/opt/playwright-browsers`), the `yaac` bin on PATH (a symlink to
`dist/cli.js`), seeded credentials + a seeded `yaac` project, and a wired
single-node cluster. Confirm the cluster is healthy:

```bash
yaac cluster check   # nested runs show several "skipped — nested yaac" lines; still ends "Cluster is ready"
```

The session's init commands run `pnpm build` then `yaac server start` **once**;
they do **not** start a `pnpm watch` loop. So a server is normally live on
`127.0.0.1:8787`, but it serves whatever `dist/` held at session start — it does
not pick up your source edits on its own. Check the server is up:

```bash
curl -s http://127.0.0.1:8787/health   # -> {"ok":true,...,"ready":true}
```

If you are testing your own changes by hand — driving the web app, hitting the
API, creating sessions — make `dist/` current first, either a one-shot
`pnpm build` (then `yaac server restart` if the buildId changed) or, better for
an edit/check loop, start `pnpm watch` yourself in the background and leave it
running: it re-runs `pnpm build` then `yaac server start` on every source
change. Otherwise you are exercising the code as it was when the session began.

If nothing is listening, start it: `yaac server start` (background) or
`pnpm watch`. Lifecycle subcommands: `yaac server start|stop|restart|logs`
(there is **no** `status` — use `/health` or `$YAAC_DATA_DIR/.server.lock`).

## Build

Nothing rebuilds `dist/` for you unless you started `pnpm watch` yourself — the
init commands build it once, at session start. Build by hand:

```bash
pnpm build   # tsup CLI bundle + vite frontend + copies dockerfiles/k8s/drizzle; ~7s, deterministic buildId
```

The server stays healthy across a rebuild (buildId is a content hash — an
unchanged tree yields the same id, so the live server isn't bounced), which also
means a rebuilt `dist/` does not reach the live server by itself: restart it
(`yaac server restart`) or run the `pnpm watch` loop, which does both.

## Run — web app (agent path)

The driver does the one-time-token → session-cookie handshake `yaac open` does,
against the already-running server, in headless Chromium. It reads the port +
lock secret from `$YAAC_DATA_DIR/.server.lock` (falls back to `~/.yaac`).

```bash
node .claude/skills/run-yaac/driver.mjs shot                       # -> /tmp/yaac-shots/app.png
node .claude/skills/run-yaac/driver.mjs shot skills --click '[aria-label="Skills"]'   # reach an interior view, then shoot
node .claude/skills/run-yaac/driver.mjs eval 'document.title'      # run JS against the live DOM, print JSON
node .claude/skills/run-yaac/driver.mjs open                       # just load + report resolved URL/title
```

Screenshots land in `/tmp/yaac-shots/<name>.png` — **open the file and look at
it**; a blank frame means the load or auth failed.

| command | what it does |
|---|---|
| `shot [name]` | authenticate, load app, screenshot → `/tmp/yaac-shots/<name>.png` (default `app`) |
| `eval '<js>'` | evaluate an expression against the page, print the JSON result |
| `open` | load the app and report the resolved URL + title |

Flags (any command): `--goto <path>` (route to load, default `/`),
`--click <selector>` (click after load), `--wait <selector>`, `--url <origin>`
(default `http://127.0.0.1:<lock.port>`), `--settle <ms>` (post-load pause for
pushed `/events`, default 3000), `--full` (full-page screenshot). Selectors are
Playwright: `text=New session`, `[aria-label="Skills"]`, or any CSS.

## Run — CLI (agent path)

The CLI drives the same on-disk state as the web app. Representative read-only
commands (all verified working here):

```bash
yaac --help
yaac project list                 # seeded env has one project: "yaac"
yaac session list                 # "No active sessions" until you create one
yaac tool get                     # default agent tool (claude/codex/opencode/pi)
yaac auth list                    # masked credentials
```

Full command reference is in `README.md` (`## CLI`). A session create
(`yaac session create <project>`) builds an image and launches a k8s Job —
slow; only run it when you specifically need a live session. On success it
**attaches to the session's tmux** and never exits — from a script, expect
to kill/timeout it (the session is fine) and clean up with
`yaac session delete <id>`.

## Run — human path

```bash
yaac open              # starts the server if needed, opens a browser into the authenticated app
yaac open --no-browser # prints the tokenized URL instead: http://127.0.0.1:8787/?token=...
```

The desktop app (`pnpm desktop:dev`) is a macOS Electron shell that loads this
same web app in a native window — not part of `pnpm build`, not driveable
headless here; drive the web app instead. See `packages/desktop/README.md`.

## Test

```bash
pnpm lint                          # typecheck (tsc x2) + eslint — the single typecheck entry point
pnpm exec vitest run <file>        # one test file, e.g. packages/shared/test/ansi.test.ts (~0.4s)
pnpm test:unit                     # all co-located unit suites
```

`pnpm test:e2e`, `test:e2e-cli`, `test:api` need the wired cluster and are
heavy/slow — run a targeted file, not the whole suite (back-to-back full runs
can exhaust podman state). Every exported function has a unit test in its
package's `test/` dir; that's the direct-invocation path for internal changes.

## Gotchas

- **Fresh browser per driver run.** Each invocation launches a new Chromium and
  mints a new one-time token; state does not carry between runs. To reach an
  interior view *and* screenshot it, do it in one run with `--goto`/`--click` —
  you cannot `eval` in one run and `shot` in the next expecting shared state.
- **The live server does not follow your edits.** No `pnpm watch` runs unless
  you start one, so a change to server or frontend source is invisible to the
  running server (and to the driver's screenshots) until `pnpm build` +
  `yaac server restart`. If a fix "does nothing", check that first — compare
  `/health`'s buildId before and after your rebuild.
- **No `yaac server status`.** The subcommands are `run/start/stop/restart/logs`.
  Probe liveness with `curl .../health` or read `.server.lock`.
- **`cluster check` "skipped" lines are normal nested.** Inside a nested yaac
  session most node/egress/vap checks print `skipped — nested yaac`; the run
  still ends "Cluster is ready for yaac sessions." with exit 0.
- **The web app auto-selects the single seeded project** (URL becomes
  `?project=yaac`); an empty install would land on a project picker instead.
- **`image-prewarm ... ENOENT: dist/dockerfiles/Dockerfile.default` in
  `server.log`** appears before a full `pnpm build` has populated `dist/` — a
  one-shot `pnpm build` fixes it; harmless for driving the web app.

## Troubleshooting

- **`no .server.lock found ... is the server running?`** — no server up. Start
  it: `yaac server start` (or `pnpm watch`), then retry the driver.
- **Playwright `Executable doesn't exist` / browser-download banner** — the
  Chromium path wasn't found. The driver defaults `PLAYWRIGHT_BROWSERS_PATH` to
  `/opt/playwright-browsers`; if your image differs, export it to the right dir.
- **`token mint failed: HTTP 401`** — the lock secret is stale (server
  restarted). Re-read is automatic per run; if it persists, confirm
  `.server.lock` matches the live server (`curl .../health` buildId).
- **Blank/half-rendered screenshot** — the pushed `/events` snapshot hadn't
  populated. Raise `--settle` (e.g. `--settle 5000`) or add `--wait <selector>`
  for a marker in the view you're capturing.
