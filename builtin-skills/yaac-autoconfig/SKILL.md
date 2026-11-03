---
name: yaac-autoconfig
description: Generate yaac config templates for the current repo — init steps that install, build, and start the project's dev server, and a yaac-config.json that forwards its ports — for the user to apply to their project's yaac config. Use when the user asks to auto-configure yaac for this project, get the app running in new workspaces, or expose a running dev server / preview from a yaac workspace.
---

You are running **inside a yaac workspace** — a sandboxed container holding a
checkout of some project. This skill writes two templates to that repo's root,
`yaac-init-steps.json` and `yaac-config.json`, that, **once the user applies
them to their project**, make *future* sessions boot with the app already
built, running, and reachable from the host browser.

The job has three parts:

1. **Prove it in this sandbox now.** Figure out how the project installs,
   builds, and serves, run those commands here, and confirm the server comes up
   on a known port. Discovery is empirical — don't guess the commands, run them.
2. **Write the templates.** Write a `yaac-init-steps.json` to the repo root
   whose steps reproduce that install→build→serve sequence, and a
   `yaac-config.json` whose `portForward` exposes the port you confirmed.
3. **Hand off the apply step.** The repo-root files are templates — yaac does
   not read them automatically (see below). Tell the user how to apply them to
   their project so they take effect.

## How the project config actually behaves (read this first)

- **The repo-root files are templates, not the live config.** yaac keeps each
  project's init steps on the server, set **only** with
  `yaac config init-steps <project> --file <file>` or the web app's Settings →
  Project Config → Init steps, and its `yaac-config.json` in the server's
  project config dir, set **only** with `yaac config edit <project>` or the web
  app's project config editor. The files you write at the repo root are
  **never read automatically** by session create — they're convenient,
  version-controlled starting points the user applies. Nothing you write takes
  effect until it's applied there.
- **Applying it is a host-side step you can't do from in here.** This session is
  a sandbox; the host's `~/.yaac` and the `yaac` CLI/daemon aren't reachable
  from inside it. So you produce the template and hand the apply step to the
  user (part 3 / step 5). You also can't "test port forwarding" from inside this
  session — validate the *commands and port* here; forwarding takes effect once
  the config is applied and a new session boots.
- **Init steps run on every start and restart, not just the first.** Keep them
  idempotent and cache-friendly (`npm ci` / `pnpm install` against the warm
  shared package cache is fine; a destructive one-time migration is not).
- **Port forwarding dials `localhost` inside the pod.** yaac forwards a
  container port to the host by running `nc localhost <containerPort>` *inside*
  the pod. So any server reachable at `localhost:<port>` inside the container is
  forwardable — binding `127.0.0.1`, `::1`, or `0.0.0.0` all work. The one thing
  that breaks it is a server that binds *only* a specific non-loopback
  interface; if you hit that, make the start command bind `0.0.0.0`.
- **`hostPortStart` is a preferred starting point, not a guarantee.** If it's
  taken on the host, yaac scans upward (up to ~100 ports). The actual mapping
  shows up in the terminal's tmux status line, and as the Preview button in
  the desktop and iPhone apps, which load `http://127.0.0.1:<hostPort>`.

## Procedure

### 1. Detect how the project builds and runs

Read the manifests and docs — don't assume a stack:

- **Node**: `package.json` `scripts` (`dev`, `start`, `build`, `preview`),
  lockfile picks the package manager (`pnpm-lock.yaml`→pnpm,
  `yarn.lock`→yarn, else npm).
- **Python**: `pyproject.toml` / `requirements.txt`, a `manage.py` (Django),
  `uvicorn`/`flask`/`fastapi` entrypoints.
- **Go**: `go.mod` + `main.go`; **Rust**: `Cargo.toml`; **Ruby**: `Gemfile` +
  `Procfile`/`bin/rails s`.
- **Container-native**: `docker-compose.yml` / `Dockerfile` — see the
  `nestedContainers` note below.
- The **README / CONTRIBUTING** almost always state the dev command and the
  port. Prefer what the project documents.

Note the port the dev server listens on (a `PORT` env var, a config file, a
hardcoded default like Vite's 5173 / Next's 3000 / Rails' 3000).

### 2. Run it in this sandbox

Execute the sequence you found — install, then build, then start the server.
Start the long-running server in the background (or a separate pane) so you can
keep probing:

- **Blocked egress**: if install/build fails reaching a host, the proxy blocked
  it. Common package registries (npm, PyPI, crates.io, Go proxy, apt, GitHub,
  Docker Hub) are on the default allowlist. Record any *extra* host you needed —
  the user adds it to the project's egress allowlist (not the config file).
- **Missing system tooling**: if the build needs a compiler, runtime, or system
  package the image lacks, that belongs in the project's **`Dockerfile.yaac`**
  (`yaac config edit-dockerfile <project>`), **not** an init step — sessions
  aren't root and init steps shouldn't try to `apt-get`. Call this out to
  the user; it's a separate step from writing the templates.

### 3. Verify the server is up and pin the port

```bash
ss -ltnp        # list listening TCP sockets (find the real port + bind addr)
curl -sSf http://localhost:<port>/   # confirm it answers
```

Confirm which port actually serves the app and that it's on a loopback or
`0.0.0.0` bind. If the framework bound only a private interface, switch the
start command to bind `0.0.0.0` (e.g. `vite --host`, `next dev -H 0.0.0.0`,
`rails s -b 0.0.0.0`, `uvicorn --host 0.0.0.0`).

### 4. Write `./yaac-init-steps.json` and `./yaac-config.json`

Keep them minimal — only what this project needs.

- **`yaac-init-steps.json`**: the install→build→serve sequence as steps by
  name (docs/workspace-steps.md). Each step runs in a tmux window of its own,
  its `run` commands in order in one shell, stopping at the first failure. A
  step starts once every step its `needs` lists has succeeded, so shared
  setup runs once and the rest wait on it. A long-running server is a
  `service`: its last command keeps running, and the steps that need it wait
  for its `ready` check (any command that exits 0 once it serves):
  ```json
  {
    "install": { "run": "pnpm install" },
    "build": { "run": "pnpm build", "needs": ["install"] },
    "web": { "run": "pnpm start", "service": true, "needs": ["build"],
             "ready": "curl -sf localhost:3000/" }
  }
  ```
  Several servers are several services, which run side by side and can be
  inspected independently.
- **`yaac-config.json` `portForward`**: only the ports the user actually opens from the host —
  usually just the web/UI you validate in the preview. Internal services the app
  reaches in-container (an API the frontend calls, a database) don't need
  forwarding unless the user wants to hit them directly. Mirror the container
  port as `hostPortStart` when it's likely free, or offset into a high range:
  ```json
  "portForward": [{ "containerPort": 5173, "hostPortStart": 5173 }]
  ```

### 5. Report back

Tell the user:
- what you wrote and why (the detected stack + commands),
- **how to apply them** — the repo-root files are templates and do nothing
  until applied. On the host, run
  `yaac config init-steps <project> --file yaac-init-steps.json` and
  `yaac config edit <project>`, pasting `yaac-config.json`'s contents (or use
  the web app's Settings → Project Config: Init steps and the config editor).
- that it then takes effect on the **next** session created for this project
  (not the current one),
- how they'll reach the app: the Preview button in the desktop or iPhone app
  (or `yaac forward`, then `http://localhost:<hostPort>` in a browser), where
  `hostPort` starts at your `hostPortStart` and may increment if that host
  port was busy,
- any follow-up they still owe — e.g. adding a toolchain to `Dockerfile.yaac`,
  or adding the extra egress hosts the build needed under Settings → Project
  Config → Egress allowlist (or with the blocked-hosts badge's "Allow
  permanently for this project").

## Worked example

A Vite SPA (port 5173) plus a Node API (port 8080), verified to build and serve
in-sandbox. Both run in-container, but only the frontend is forwarded — that's
what the user opens to validate the app; the SPA reaches the API over
`localhost:8080` inside the pod (e.g. through Vite's dev-server proxy), so the
API needs no host forward:

`yaac-init-steps.json`:

```json
{
  "install": { "run": "pnpm install" },
  "api": { "run": "pnpm --filter api dev", "service": true, "needs": ["install"],
           "ready": "curl -sf localhost:8080/health" },
  "web": { "run": "pnpm --filter web dev -- --host", "service": true, "needs": ["install"] }
}
```

`yaac-config.json`:

```json
{ "portForward": [{ "containerPort": 5173, "hostPortStart": 5173 }] }
```

Forward the API too only if the user needs to reach it directly from the host —
e.g. to `curl` it, or if the SPA calls it from the browser rather than through
an in-container proxy.

## Full config reference

A step in `yaac-init-steps.json` takes `run` (a command or a list), `needs`
(step names), `service` (`true` for a long-running one) and `ready` (a
service's readiness check). Its name must not be an agent tool's (`claude`,
`codex`, `opencode`, `pi`, or one of those followed by `-`), `yaac`, or
`shell`/`shell-<n>`. Every step's output is kept in its log
(`yaac workspace logs <workspace> <step>`).

Every `yaac-config.json` option is optional. Include only what the project
needs.

| Option | Type | Purpose |
|---|---|---|
| `portForward` | `{containerPort, hostPortStart}[]` | Forward an in-container port to the host. `hostPortStart` is the preferred host port; yaac scans upward if it's busy. |
| `cacheVolumes` | `Record<string,string>` | Per-project persistent caches that survive across sessions. Key = cache name, value = absolute container path. (pnpm's store is already shared at `~/.cached-packages` — no entry needed.) |
| `nestedContainers` | `boolean` | Run an in-pod podman so `docker build`/`run`/`compose up` work inside the session (the `docker` CLI talks to podman's socket). Needed for docker-compose-based projects. |

Dependency and build-output dirs each workspace keeps off its checkout
(`node_modules` and `target` by default) are a project setting, not a config
key: Settings → Project Config, or `yaac config scratch-dirs`.

## Gotchas

- **The repo-root files are templates — yaac never auto-loads them.** They only
  take effect once applied (`yaac config init-steps`, `yaac config edit`, or the
  web app). Even then they apply to the *next* session, not the current one —
  validate commands/port here; forwarding happens at the next boot.
- **Init steps run on every start** — make them idempotent.
- **A step's commands stop at the first non-zero exit.** Put a service's
  long-running command last; anything after it never runs (it doesn't exit).
- **Bind matters only for non-loopback servers.** The relay dials `localhost`
  inside the pod, so `127.0.0.1`/`::1`/`0.0.0.0` are all fine; a private-only
  bind needs `--host 0.0.0.0`.
- **Environment variables are not in this file.** They are stored with the
  project and edited in the web app under Settings → Project Config →
  Environment (a secret there is encrypted, and under the k8s driver its value
  is injected by the egress proxy rather than placed in the container). If the
  project needs any, say which in your summary rather than writing a config key
  for them — there is none.
- **There is no way to mount a host directory.** Use `cacheVolumes` for a
  directory that should persist across sessions, or bake the contents into the
  project image.
- **docker-compose projects need `nestedContainers: true`**.
