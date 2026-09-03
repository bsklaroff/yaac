---
name: yaac-autoconfig
description: Generate a yaac-config.json template for the current repo — a config that installs, builds, and starts the project's dev server and forwards its ports — for the user to apply to their project's yaac config. Use when the user asks to auto-configure yaac for this project, get the app running in new worktrees, or expose a running dev server / preview from a yaac worktree.
---

You are running **inside a yaac worktree** — a sandboxed container holding a
checkout of some project. This skill writes a `yaac-config.json` to that repo's
root that, **once the user applies it to their project config**, makes *future*
sessions boot with the app already built, running, and reachable from the host
browser.

The job has three parts:

1. **Prove it in this sandbox now.** Figure out how the project installs,
   builds, and serves, run those commands here, and confirm the server comes up
   on a known port. Discovery is empirical — don't guess the commands, run them.
2. **Write the template.** Write a `yaac-config.json` to the repo root whose
   `initCommands` reproduce that install→build→serve sequence and whose
   `portForward` exposes the port you confirmed.
3. **Hand off the apply step.** The repo-root file is a template — yaac does not
   read it automatically (see below). Tell the user how to copy it into their
   project config so it takes effect.

## How yaac-config.json actually behaves (read this first)

- **The repo-root file is a template, not the live config.** yaac reads each
  project's config from `~/.yaac/projects/<slug>/config/yaac-config.json` on the
  host, which is populated **only** via `yaac config edit <project>` or the web
  app's project config editor. The `yaac-config.json` you write at the repo root
  is **never read automatically** by session create — it's a convenient,
  version-controlled starting point the user copies into that project config.
  Nothing you write takes effect until it's applied there.
- **Applying it is a host-side step you can't do from in here.** This session is
  a sandbox; the host's `~/.yaac` and the `yaac` CLI/daemon aren't reachable
  from inside it. So you produce the template and hand the apply step to the
  user (part 3 / step 5). You also can't "test port forwarding" from inside this
  session — validate the *commands and port* here; forwarding takes effect once
  the config is applied and a new session boots.
- **`initCommands` run on every session, not just the first.** Keep them
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
  shows up as clickable `:hostPort` chips in the web app (and in the terminal's
  tmux status line), opening `http://<host>:<hostPort>`.

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
  it goes in `addAllowedUrls`.
- **Missing system tooling**: if the build needs a compiler, runtime, or system
  package the image lacks, that belongs in the project's **`Dockerfile.yaac`**
  (`yaac config edit-dockerfile <project>`), **not** `initCommands` — sessions
  aren't root and `initCommands` shouldn't try to `apt-get`. Call this out to
  the user; it's a separate step from writing the config.

### 3. Verify the server is up and pin the port

```bash
ss -ltnp        # list listening TCP sockets (find the real port + bind addr)
curl -sSf http://localhost:<port>/   # confirm it answers
```

Confirm which port actually serves the app and that it's on a loopback or
`0.0.0.0` bind. If the framework bound only a private interface, switch the
start command to bind `0.0.0.0` (e.g. `vite --host`, `next dev -H 0.0.0.0`,
`rails s -b 0.0.0.0`, `uvicorn --host 0.0.0.0`).

### 4. Write `./yaac-config.json`

Keep it minimal — only the options this project needs.

- **`initCommands`**: the install→build→serve sequence.
  - *Single server* → **string form** (chained with `&&` in one `init` tmux
    window; the last, long-running command is the server):
    ```json
    "initCommands": ["pnpm install", "pnpm build", "pnpm start"]
    ```
  - *Multiple long-running servers* (e.g. an API and a web frontend) →
    **object form**, one tmux window each so they run in parallel and can be
    inspected independently. Windows are independent, so repeat shared setup
    (install) in each:
    ```json
    "initCommands": [
      { "name": "api", "commands": ["pnpm install", "pnpm dev:api"] },
      { "name": "web", "commands": ["pnpm install", "pnpm dev:web"] }
    ]
    ```
- **`portForward`**: only the ports the user actually opens from the host —
  usually just the web/UI you validate in the preview. Internal services the app
  reaches in-container (an API the frontend calls, a database) don't need
  forwarding unless the user wants to hit them directly. Mirror the container
  port as `hostPortStart` when it's likely free, or offset into a high range:
  ```json
  "portForward": [{ "containerPort": 5173, "hostPortStart": 5173 }]
  ```
- **`addAllowedUrls`**: only the extra egress hosts the build actually needed.

### 5. Report back

Tell the user:
- what you wrote and why (the detected stack + commands),
- **how to apply it** — the repo-root file is a template and does nothing until
  copied into the project config. On the host, run `yaac config edit <project>`
  and paste the file's contents (or use the web app's project config editor).
- that it then takes effect on the **next** session created for this project
  (not the current one),
- how they'll reach the app: the forwarded-port chip in the web app opens
  `http://<host>:<hostPort>`, where `hostPort` starts at your `hostPortStart`
  and may increment if that host port was busy,
- any follow-up they still owe — e.g. adding a toolchain to `Dockerfile.yaac`.

## Worked example

A Vite SPA (port 5173) plus a Node API (port 8080), verified to build and serve
in-sandbox. Both run in-container, but only the frontend is forwarded — that's
what the user opens to validate the app; the SPA reaches the API over
`localhost:8080` inside the pod (e.g. through Vite's dev-server proxy), so the
API needs no host forward:

```json
{
  "initCommands": [
    { "name": "api", "commands": ["pnpm install", "pnpm --filter api dev"] },
    { "name": "web", "commands": ["pnpm install", "pnpm --filter web dev -- --host"] }
  ],
  "portForward": [{ "containerPort": 5173, "hostPortStart": 5173 }]
}
```

Forward the API too only if the user needs to reach it directly from the host —
e.g. to `curl` it, or if the SPA calls it from the browser rather than through
an in-container proxy.

## Full config reference

Every option is optional. Include only what the project needs.

| Option | Type | Purpose |
|---|---|---|
| `initCommands` | `string[]` \| `{name, commands[], hidePane?}[]` | Commands run in every session after the container starts. String form: chained with `&&` in one `init` tmux window. Object form: one window per entry (parallel), `name` must not be a reserved window name (`claude`/`codex`/`opencode`/`pi`/`init`/`yaac`). |
| `portForward` | `{containerPort, hostPortStart}[]` | Forward an in-container port to the host. `hostPortStart` is the preferred host port; yaac scans upward if it's busy. |
| `hideInitPane` | `boolean` (default `false`) | When `true`, close the init tmux pane after commands finish/error instead of keeping it (with `remain-on-exit`) for inspection. Per-window override via each object entry's `hidePane`. |
| `cacheVolumes` | `Record<string,string>` | Per-project persistent caches that survive across sessions. Key = cache name, value = absolute container path. (pnpm's store is already shared at `~/.cached-packages` — no entry needed.) |
| `addAllowedUrls` | `string[]` | Extra host patterns to allow past the egress proxy, on top of the default allowlist. Exact (`api.example.com`) or wildcard (`*.example.com`). Mutually exclusive with `setAllowedUrls`. |
| `setAllowedUrls` | `string[]` | **Replace** the default allowlist entirely. `["*"]` allows all (disables filtering); `[]` blocks all egress. Warns if it omits `api.anthropic.com`/`github.com`. Mutually exclusive with `addAllowedUrls`. |
| `nestedContainers` | `boolean` | Run an in-pod podman so `docker build`/`run`/`compose up` work inside the session (the `docker` CLI talks to podman's socket). Needed for docker-compose-based projects. |
| `ephemeralModulesPaths` | `string[]` (default `["node_modules"]`) | Paths (relative to `/workspace`) bind-mounted onto per-session storage so package-manager writes don't touch the host worktree. `[]` disables the redirect. |
| `referenceBranch` | `string` | Default branch on `origin` (no `origin/` prefix) that new session worktrees branch from. Unset → the remote's default branch. Overridable per create. |

## Gotchas

- **The repo-root file is a template — yaac never auto-loads it.** It only takes
  effect once copied into the project config (`yaac config edit <project>` or the
  web editor). Even then it applies to the *next* session, not the current one —
  validate commands/port here; forwarding happens at the next boot.
- **`initCommands` run every session** — make them idempotent.
- **String-form chains stop on the first non-zero exit.** Put the long-running
  server last; anything after it never runs (it doesn't exit).
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
