# Yet Another Agent Container

Agent sandbox manager — run many parallel agent sessions, each as an isolated Kubernetes Job on a local single-node cluster. Supports Claude Code, Codex CLI, and OpenCode.

## Install

Clone the repo and install globally:

```sh
git clone https://github.com/bsklaroff/yaac.git
cd yaac
pnpm install
pnpm build
npm install -g .
```

yaac splits the container runtime in two:

- **Podman** builds session images (`podman build` / `podman push`) and hosts the kind node container. Install version 5.0+ (podman 6.x needs kind >= v0.33.0 — see [Cluster setup](#cluster-setup)):

  ```sh
  # Debian / Ubuntu (25.04+)
  sudo apt install podman
  ```

  On macOS, podman runs inside a VM, and yaac needs two non-default machine settings: **rootful** (kind requires it) and the **libkrun provider** (session pods run in user namespaces, which need idmapped-mount support on the VM's file sharing — libkrun's virtiofs has it, Apple's Virtualization.framework does not):

  ```sh
  brew install podman
  brew trust libkrun/krun
  brew install libkrun/krun/krunkit
  printf '[machine]\nprovider = "libkrun"\n' >> ~/.config/containers/containers.conf
  podman machine init --rootful --cpus 8 --memory 32768
  podman machine start
  ```

  > **Clock drift after sleep:** the machine's clock freezes while the Mac sleeps ([podman#11541](https://github.com/containers/podman/issues/11541)), and NTP can't always recover — the pauses also corrupt chrony's measurements (`exceeds maxjitter` / `Can't synchronise: no selectable sources` in the VM journal), so builds fail with `podman build exited with code 100` / apt `Release file ... is not valid yet`. The real fix is krunkit's `--timesync` (>= 1.2.0): the host pushes its clock into the guest over vsock on every wake. podman doesn't pass the flag yet ([podman#28345](https://github.com/containers/podman/issues/28345)), so wire it manually:
  >
  > ```sh
  > # 1. guest side: qemu-guest-agent listening on vsock port 1234
  > podman machine ssh "sudo rpm-ostree install qemu-guest-agent"
  > podman machine ssh "sudo tee /etc/systemd/system/qemu-ga-vsock.service" <<'EOF'
  > [Unit]
  > Description=QEMU Guest Agent on vsock (krunkit --timesync receiver)
  > [Service]
  > ExecStart=/usr/bin/qemu-ga --method=vsock-listen --path=3:1234
  > Restart=always
  > [Install]
  > WantedBy=multi-user.target
  > EOF
  > podman machine ssh "sudo systemctl enable qemu-ga-vsock.service"
  > # Fedora's SELinux policy lacks vsock perms for qemu-ga — allow them:
  > #   allow virt_qemu_ga_t self:vsock_socket { create bind listen accept getattr setattr read write shutdown };
  > # (compile with checkmodule/semodule_package — e.g. in a fedora container — and `semodule -i`)
  >
  > # 2. host side: wrap krunkit so podman's invocation gains --timesync
  > mv /opt/homebrew/bin/krunkit /opt/homebrew/bin/krunkit-real 2>/dev/null || true
  > printf '#!/bin/sh\ncase " $* " in\n  *" --bootloader "*) exec /opt/homebrew/bin/krunkit-real "$@" --timesync vsockPort=1234 ;;\n  *) exec /opt/homebrew/bin/krunkit-real "$@" ;;\nesac\n' > /opt/homebrew/bin/krunkit
  > chmod +x /opt/homebrew/bin/krunkit
  > podman machine stop && podman machine start   # then re-run scripts/setup-kind-cluster.sh
  > ```
  >
  > All of this manual wiring is upstreamed for podman 6.0 (not yet in Homebrew — `brew install podman` is still 5.8.x): podman passes `--timesync vsockPort=1234` itself ([podman#28527](https://github.com/containers/podman/pull/28527)) and the machine image ships the vsock qemu-guest-agent + SELinux policy ([podman-machine-os#238](https://github.com/containers/podman-machine-os/pull/238), both merged 2026-05-26). When you upgrade to 6.0: **remove the wrapper** (`mv /opt/homebrew/bin/krunkit-real /opt/homebrew/bin/krunkit` — the duplicated flag would break machine start) and recreate the machine (`podman machine rm` + `init`) so the new image replaces the manual guest wiring. Manual recovery if the clock is ever skewed anyway:
  >
  > ```sh
  > podman machine ssh "sudo date -u -s @$(date +%s) && sudo systemctl restart chronyd"
  > ```

- **Kubernetes** runs the sessions — one Job (single-pod) per session, plus a shared proxy Deployment. yaac targets a **local single-node cluster** (kind recommended). Session pods run with `hostUsers: false` (user namespaces), so the filesystem backing your home directory must support idmapped mounts — ext4/xfs/btrfs on Linux, libkrun's virtiofs on macOS (see above).

### Cluster setup

Install [kind](https://kind.sigs.k8s.io/) and [kubectl](https://kubernetes.io/docs/tasks/tools/), then run the bundled setup script:

```sh
./scripts/setup-kind-cluster.sh
yaac cluster check
```

> **Podman 6.x requires kind >= v0.33.0 — don't bump podman alone.** Podman
> 6.0 changed the container label format from a map to a slice, which breaks
> how kind <= v0.32.0 enumerates its node containers (`kind get clusters`
> fails with `exit status 125`), so `setup-kind-cluster.sh` cannot create or
> delete a cluster. The fix is [kind#4203](https://github.com/kubernetes-sigs/kind/pull/4203)
> (merged to `main` 2026-06-26, closes [#4201](https://github.com/kubernetes-sigs/kind/issues/4201)),
> unreleased as of 2026-06-30 — the latest stable is v0.32.0 and even
> v0.33.0-alpha predates the fix. Until v0.33.0 ships, stay on podman 5.x, or
> move both together by building kind from `main` (`go install
> sigs.k8s.io/kind@main` — note `@latest` resolves to the v0.32.0 tag, which
> lacks the fix). yaac's own podman calls are unaffected (they read
> `.ID`/`.Repository`/`.Tag`, not `.Labels`); only kind's provider breaks.

The script creates a kind cluster from `k8s/kind-config.yaml` with the three pieces of wiring yaac needs:

1. **Local image registry** on `127.0.0.1:5001` — yaac pushes built session images there and pods pull them as `localhost:5001/...` (the kind [local-registry pattern](https://kind.sigs.k8s.io/docs/user/local-registry/)). Host port 5001 (not the registry-default 5000) sidesteps macOS AirPlay Receiver, which binds `::1:5000`; the container-internal port stays 5000.
2. **Home-directory extraMount** — session pods mount worktrees, caches, and credentials via `hostPath`, which resolves on the *node*. Mounting `$HOME` into the node at the same path makes node == host for everything yaac touches.
3. **Unmasked sysfs mount on the node** — session pods run in user namespaces (`hostUsers: false`), and the kernel refuses to start them while kind's `/sys` masks make sysfs "not fully visible" ([kind#3436](https://github.com/kubernetes-sigs/kind/issues/3436)). This mount lives in the node's mount namespace, so **re-run the script after a node container restart** (e.g. after restarting the podman machine).

User namespaces are what keep in-container root unprivileged: the session image grants passwordless sudo (agents can `apt-get install` mid-session), and the userns maps uid 0 in the pod to a throwaway unprivileged uid on the node — the same containment rootless podman gave the pre-kubernetes backend.

The idmapped mounts that come with user namespaces present hostPath files at their real node-side uids, so the session image builds its `yaac` user with the daemon's uid (`YAAC_UID` build arg, baked in automatically and folded into the image tag). Nothing to configure — but if your uid ever changes, images rebuild on their own, and a standalone `Dockerfile.yaac` that creates its own user should honor `ARG YAAC_UID` the same way `dockerfiles/Dockerfile.default` does, or its writes to `/workspace` will fail with `Permission denied`.

`yaac cluster check` verifies kubectl, the cluster, the registry, the namespace, and runs an end-to-end probe pod — user-namespaced, like session pods — that exercises all three wirings, including a hostPath **write** at the session uid. Run it whenever sessions fail to start.

> **v1 limits:** single-node clusters only (the hostPath model assumes node == host). The daemon's control traffic reaches the proxy through a loopback `kubectl port-forward`; nothing yaac deploys listens on host interfaces.

## Usage

```
yaac [command]

Commands:
  open            Open the web app in your browser (starts the daemon if needed)
  cluster         Manage the kubernetes cluster yaac runs sessions on
  project         Manage projects
  session         Manage sessions
  config          Edit per-machine project configuration files
  auth            Manage credentials (GitHub tokens and tool API keys)

yaac cluster <command>
  check             Verify cluster prerequisites (kubectl, registry, hostPath wiring)

yaac project <command>
  list              List all projects
  add <remote-url>  Add a project (HTTPS URL or SSH URL like git@host:path)
  rebuild <project> Rebuild the agent-CLI image layer with --no-cache

yaac session <command>
  create [options] <project>  Create a new session for a project
    -t, --tool <tool>         Agent tool to use (claude, codex, or opencode)
    --add-dir <path>          Mount a host directory read-only (repeatable)
    --add-dir-rw <path>       Mount a host directory read-write (repeatable)
  list [options] [project]    List active sessions
    -d, --deleted             List deleted sessions from agent history
  delete <session-id>         Delete a session and clean up its resources
  attach <container-id>       Attach to the agent tmux session
  stream [options] [project]  Stream through waiting sessions, attaching to
                              each in turn
    -t, --tool <tool>         Agent tool for new sessions (claude, codex, or opencode)
  monitor [options] [project] Poll and display active sessions in real-time
    -n, --interval <seconds>  Refresh interval in seconds (default: 5)

yaac tool <command>
  get                 Show the current default agent tool
  set <tool>          Set the default agent tool (claude, codex, or opencode)

yaac config <command>
  edit <project>              Open the project's yaac-config.json in $EDITOR
  edit-dockerfile <project>   Open the project's Dockerfile.yaac in $EDITOR
  edit-user-dockerfile        Open the global ~/.yaac/Dockerfile.user in $EDITOR

yaac auth <command>
  list                List configured credentials (masked)
  update              Add or update credentials (GitHub, Claude Code, Codex, or OpenCode)
  clear               Remove stored credentials (interactive)
```

Detach from a tmux session with `Ctrl-B D`. Kill the tmux session (and the
container) with `Ctrl-B K` (custom binding, not standard tmux). Open a new
shell in the tmux session with `Ctrl-B C`, and switch between shells with `Ctrl-B N` (next) and
`Ctrl-B P` (previous).

## Web app

yaac ships a local web app — a GUI over the same daemon the CLI drives.
Launch it with:

```sh
yaac open
```

This starts the daemon if needed and opens your browser straight into the
authenticated app: a live session sidebar, the project list, and an embedded
terminal (xterm.js) attached to each session's tmux. `yaac open --no-browser`
prints the URL instead of launching a browser.

It's local-first — the daemon binds `127.0.0.1` only, and the browser
authenticates with an `HttpOnly` cookie obtained from a one-time bootstrap
code that `yaac open` handles for you (no manual pasting). The CLI and web
app drive the same on-disk state, so you can mix them freely.

For frontend development, run the daemon alongside the Vite dev server:

```sh
yaac daemon start
pnpm frontend:dev   # http://localhost:1420, proxies the API to the daemon
```

For daemon/CLI development, use watch mode:

```sh
pnpm watch
```

This is `tsx watch` re-running a small wrapper script
(`scripts/dev-watch.ts`) whenever a build input changes (`src/`,
`dockerfiles/`, `k8s/`, and the build configs); each run does `pnpm build`
followed by `yaac daemon restart` — required because the CLI refuses to
talk to a daemon whose buildId doesn't match. The first run builds and
(re)starts the daemon, so `pnpm watch` alone is enough to boot a dev loop;
a failed build skips the restart, and Ctrl-C stops the watcher but leaves
the daemon running. This is also the intended inner dev loop when
developing yaac inside a yaac session (yaac-in-yaac): run `pnpm watch` in
the session and every edit lands in the inner daemon automatically.

## Authentication

yaac centralizes credentials on the host and injects them into session traffic through the shared proxy (a `yaac-proxy` Deployment in the cluster). Real tokens are never written into the container filesystem. Credentials live under `~/.yaac/.credentials/` (directory permissions `0700`, files `0600`), split by service:

- `~/.yaac/.credentials/github.json` — GitHub tokens
- `~/.yaac/.credentials/claude.json` — Claude Code credentials (OAuth bundle or API key)
- `~/.yaac/.credentials/codex.json` — Codex credentials
- `~/.yaac/.credentials/opencode.json` — OpenCode credentials (OpenRouter API key)

The proxy pod mounts this directory RW (hostPath) and reads credentials at request time, so updates via `yaac auth update` propagate to every running session immediately without needing to restart pods. The proxy is reachable only inside the cluster (ClusterIP Service); the daemon talks to it over a loopback `kubectl port-forward`.

### GitHub tokens

yaac requires one or more GitHub Personal Access Tokens (PATs) for git operations and GitHub API access inside session containers. Multiple tokens can be scoped to different owners so you can use separate tokens for different orgs or personal repos.

Tokens are stored as an ordered list. When yaac needs a token for a given repo, it walks the list and uses the first matching entry:

```json
{
  "tokens": [
    { "kind": "https", "pattern": "github.com/acme-corp/*", "token": "ghp_org_scoped_token" },
    { "kind": "https", "pattern": "github.com/my-user/private-repo", "token": "ghp_repo_scoped_token" },
    { "kind": "https", "pattern": "gitlab.com/group/sub/*", "token": "glpat_subgroup_token" },
    { "kind": "https", "pattern": "github.com/*", "token": "ghp_fallback_token" }
  ]
}
```

Each pattern is host-prefixed and takes one of these forms:
- `<host>/*` — matches every repo on `<host>`
- `<host>/<path>` — matches a specific repo at `<path>` (any depth: `acme/foo`, `group/sub/repo`, or a single segment like `myrepo` for Gerrit-style hosts)
- `<host>/<prefix>/*` — matches every repo whose path starts with `<prefix>` (the prefix itself can span multiple segments, e.g. `gitlab.com/group/sub/*`)

First match wins, so put more specific patterns before broader ones. On first run, yaac prompts for a token if none are configured.

Tokens are used for:
- **Host-side git operations** — clone and fetch use HTTPS with the matching token embedded in the request.
- **Session-side GitHub requests** — the MITM proxy injects the token as an `Authorization` header into all HTTPS requests to `github.com` and `api.github.com`. The token is never written into the container filesystem. Each session uses the single token that matches its project's remote URL.

Token injection only happens over HTTPS. Plain HTTP requests through the proxy never receive credentials.

### Agent tool credentials

yaac also manages the API credentials for the agent tool itself, so Claude Code, Codex, and OpenCode don't need to authenticate inside each container. On first run (or via `yaac auth update`), yaac runs the tool's native login flow on the host and stores the resulting credentials. OpenCode is API-key only (OpenRouter): the key stays on the host and the proxy swaps the in-container placeholder on requests to openrouter.ai.

For Claude Code OAuth, each project's `.claude/.credentials.json` inside the container holds placeholder tokens (`yaac-ph-access` / `yaac-ph-refresh`) together with the real `expiresAt` and scopes. The proxy transparently rewrites outbound API calls, swaps the placeholder refresh token on refresh requests, and writes refreshed bundles back to the host file — so real tokens never enter the container filesystem. For API-key mode (both tools) the proxy injects the key as an outbound header.

## Session layout

Each session runs as a single-pod Kubernetes Job with the following hostPath mounts:

| Host | Container | Description |
|------|-----------|-------------|
| `~/.yaac/projects/<project>/worktrees/<session-id>` | `/workspace` | Project code (working directory) |
| `~/.yaac/projects/<project>/repo/.git` | `/repo/.git` | Repository metadata |
| `~/.yaac/projects/<project>/claude/` | `/home/yaac/.claude` | Claude Code configuration |
| `~/.yaac/projects/<project>/claude.json` | `/home/yaac/.claude.json` | Claude Code project settings |
| `~/.yaac/projects/<project>/codex/` | `/home/yaac/.codex` | Codex configuration and transcripts |
| `~/.yaac/projects/<project>/opencode-config/` | `/home/yaac/.config/opencode` | OpenCode configuration (shared per project) |
| `~/.yaac/projects/<project>/opencode-data/<session-id>` | `/home/yaac/.local/share/opencode` | OpenCode session data (per session) |
| `~/.yaac/projects/<project>/.cached-packages` | `/home/yaac/.cached-packages` | Per-project package-manager caches |

The session container runs as user `yaac` with home directory `/home/yaac`. All project data is stored under `~/.yaac/projects/<repo-name>/` on the host — which is why the cluster node must have your home directory extraMounted (see [Cluster setup](#cluster-setup)). The repo plus the Claude and Codex state directories are shared across all sessions within a project (but isolated between projects), so those sessions can inspect each other's history; OpenCode session data is per-session to avoid concurrent-write issues in its database. Each session gets its own git worktree.

The `.cached-packages` directory is shared by every session within the project, so package-manager caches survive session teardown and are reused across sessions. pnpm's default `store-dir` is pre-configured to `/home/yaac/.cached-packages/pnpm-store`, so `pnpm install` populates the per-project store automatically with no extra configuration.

## Project configuration

Per-machine, per-project configuration lives under each project's data dir — not in the repo, so it's never committed and can differ per machine:

```
~/.yaac/projects/<repo-name>/config/yaac-config.json
~/.yaac/projects/<repo-name>/config/Dockerfile.yaac
~/.yaac/Dockerfile.user
```

The easiest way to populate these is in `$EDITOR`:

```
yaac config edit <project>             # yaac-config.json
yaac config edit-dockerfile <project>  # Dockerfile.yaac
yaac config edit-user-dockerfile       # ~/.yaac/Dockerfile.user (global)
```

Example `yaac-config.json` with all options:

```json
{
  "envPassthrough": ["TERM", "LANG"],
  "env": {
    "NODE_ENV": "development",
    "MY_FLAG": "1"
  },
  "envSecretProxy": {
    "MY_API_KEY": {
      "hosts": ["api.example.com"],
      "header": "x-api-key"
    },
    "OAUTH_CLIENT_ID": {
      "hosts": ["auth.example.com"],
      "path": "/oauth/*",
      "bodyParam": "client_id"
    },
    "OAUTH_CLIENT_SECRET": {
      "hosts": ["auth.example.com"],
      "path": "/oauth/*",
      "bodyParam": "client_secret"
    }
  },
  "bindMounts": [
    { "hostPath": "$HOME/datasets", "containerPath": "/mnt/datasets", "mode": "ro" },
    { "hostPath": "$HOME/models", "containerPath": "/mnt/models", "mode": "rw" }
  ],
  "cacheVolumes": {
    "pip-cache": "/home/yaac/.cache/pip"
  },
  "initCommands": ["pnpm install"],
  "addAllowedUrls": ["internal.corp.example.com", "*.mycdn.example.com"],
  "hideInitPane": false
}
```

- **envPassthrough** — environment variables passed directly from your host to the container.
- **env** — environment variables hardcoded with literal values, baked into the container at session creation. Applied after `envPassthrough`, so a name listed in both takes the literal value here. Values are not expanded — `"$HOME"` is passed through as the literal string `$HOME`.
- **envSecretProxy** — environment variables injected via a MITM proxy into HTTPS requests. The actual secret value never enters the container. Each entry specifies how the secret is injected:
  - **`hosts`** — hostnames to intercept (required).
  - **`header`** — inject as this HTTP header (default: `"authorization"`). When using the default header, the value is automatically prefixed with `"Bearer "`. Use `prefix` to override.
  - **`bodyParam`** — instead of a header, replace this form/JSON body parameter. Useful for OAuth client credentials that are sent in POST bodies.
  - **`path`** — only inject on matching URL paths (default `"/*"`). Supports `*` wildcards.

  Each entry must have either `header` or `bodyParam` (not both).

  Note: GitHub authentication (`github.com` and `api.github.com`) is handled automatically using your stored PAT — you do not need to add `GITHUB_TOKEN` to `envSecretProxy`.
- **bindMounts** — host directories mounted into the container. Each entry specifies:
  - **`hostPath`** — absolute path on the host (required). Environment variables like `$HOME` or `${HOME}` are expanded.
  - **`containerPath`** — absolute path inside the container (required).
  - **`mode`** — `"ro"` for read-only or `"rw"` for read-write (required).

  For ad-hoc mounts at session creation time, use the `--add-dir` / `--add-dir-rw` CLI flags instead. These mount the host directory under `/add-dir/<host-path>` inside the container and automatically pass it to Claude Code via `--add-dir`.
- **cacheVolumes** — per-project persistent cache directories mounted into the container. Keys are cache names (backed by `~/.yaac/projects/<project>/cache-volumes/<name>` on the host), values are absolute container paths. Caches persist across sessions. Note: a per-project `~/.yaac/projects/<project>/.cached-packages` directory is already bind-mounted at `/home/yaac/.cached-packages` on every container for pnpm (and other package-manager caches you want to share across sessions), so you don't need a `cacheVolumes` entry for pnpm's store.
- **initCommands** — commands run inside the container after it starts (e.g. `pnpm install` against the warm shared cache). These run on every session, not just the first. Accepts two shapes (cannot be mixed):
  - **String list** — all commands are chained with `&&` and run in a single tmux window named `init`, parallel to the agent:
    ```json
    "initCommands": ["pnpm install", "pnpm build"]
    ```
  - **Object list** — one tmux window per entry, so multiple long-running processes (e.g. a backend and a frontend dev server) run in parallel and can be inspected independently. Each entry has a `name` (the tmux window name; must not collide with the agent window — `claude` / `codex` / `opencode` / `init` / `yaac` are reserved), a `commands` array (chained with `&&` inside that window), and an optional `hidePane` that overrides the top-level `hideInitPane` for this window. Windows are spawned independently, so any shared setup (e.g. `pnpm install`) should be listed in each window that needs it:
    ```json
    "initCommands": [
      { "name": "backend",  "commands": ["pnpm install", "pnpm dev:backend"] },
      { "name": "frontend", "commands": ["pnpm install", "pnpm dev:frontend"] }
    ]
    ```
- **hideInitPane** — when `true`, the init commands tmux pane is automatically closed after the commands finish or error (default: `false`). When `false`, the pane is preserved with `remain-on-exit` so you can inspect the output.
- **addAllowedUrls** — additional host patterns to allow on top of the [default allowlist](src/lib/container/default-allowed-hosts.ts). By default, the proxy blocks outbound requests to hosts not on the default list. Use this to add extra hosts without replacing the defaults. Supports exact hostnames (`api.example.com`) and wildcards (`*.example.com`).
- **setAllowedUrls** — completely replaces the default allowlist with the given list of host patterns. Cannot be used together with `addAllowedUrls`. Set to `["*"]` to allow all outbound URLs (disables filtering), or `[]` to block all external network access. If the resolved list does not include `api.anthropic.com` or `github.com`, a warning is printed since sessions require these to function.
- **nestedContainers** — run an in-pod rootless podman so `docker build` / `docker run` / `docker compose up --build` work inside the session exactly as a project README instructs (the `docker` CLI talks to podman's Docker-API socket). See [Nested containers and virtual clusters](#nested-containers-and-virtual-clusters).
- **virtualCluster** — give each session its own virtual kubernetes cluster (vcluster) plus a per-project push registry. Implies `nestedContainers` (setting `"nestedContainers": false` alongside it is a config error).

## Environment variables

Every yaac variable is read in one place — [`src/shared/env.ts`](src/shared/env.ts) — which owns its default and validation. The rest of the codebase imports the typed `env` / `testEnv` accessors instead of touching `process.env`.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `YAAC_DATA_DIR` | `~/.yaac` | Data directory holding projects, sessions, and the daemon lock. |
| `YAAC_DAEMON_PORT` | `8787` | Port the daemon binds on `127.0.0.1` (auto-increments if busy). `0` requests an OS-assigned ephemeral port. |
| `YAAC_USE_TOR` | `false` | Route the daemon's host-side git/ssh through a Tor SOCKS proxy. Off when unset/empty/`0`/`false`; any other value is on. |
| `YAAC_HOST_TOR_SOCKS_URL` | `socks5h://127.0.0.1:9050` | SOCKS endpoint used when `YAAC_USE_TOR` is on. |
| `YAAC_K8S_REGISTRY` | `localhost:5001` | `host:port` of the local OCI registry the cluster pulls session images from. |
| `YAAC_PREWARM_POOL_SIZE` | `1` | Prewarmed sessions kept ready per active project (`0` disables prewarming). |
| `YAAC_NESTED` | _(unset)_ | Set to `1` automatically by the daemon inside a nested (vcluster) session — not something you set yourself. |
| `YAAC_BUNDLED` | _(unset)_ | Set to `true` by the build (tsup) in the shipped bundle so it loads assets from `dist/`. Build-time define, not a runtime knob. |
| `EDITOR` / `VISUAL` | `vi` | Editor opened by the `yaac config edit*` commands (git's convention: `$EDITOR`, then `$VISUAL`, then `vi`). |

`YAAC_UID` is a Docker **build arg** (not a runtime variable) — see [Custom images](#custom-images).

### Internal & testing

These are set by the build or the test harness; production reads several of them only via their defaults.

| Variable | Default | Description |
|----------|---------|-------------|
| `YAAC_K8S_NAMESPACE` | `yaac` | Namespace holding every yaac k8s object. E2e runs isolate per-file namespaces here. |
| `YAAC_IMAGE_PREFIX` | _(unset)_ | Prefix applied to built/pushed image names (test isolation). |
| `YAAC_PROXY_IMAGE` | `yaac-proxy` | Proxy image tag override. |
| `YAAC_REQUIRE_PREBUILT_IMAGES` | _(unset)_ | `1` fails fast if a required image isn't already in the registry (CI/e2e). |
| `YAAC_STARTING_GRACE_MS` | `60000` | Grace window (ms) protecting freshly-created session pods from the stale-session reaper. |
| `YAAC_BUILD_ID` | _(unset)_ | Override the build id for tests running from source (no `dist/.build-id`). |
| `YAAC_DAEMON_URL` / `YAAC_DAEMON_SECRET` / `YAAC_DAEMON_BUILD_ID` | _(unset)_ | Point the CLI at an in-process daemon without the lock file (tests). |
| `YAAC_E2E_NO_ATTACH` | _(unset)_ | `1` skips the post-provision `kubectl exec -it` attach (no-TTY e2e). |
| `YAAC_E2E_SKIP_FETCH` | _(unset)_ | `1` skips the host-side git fetch during create (e2e fixtures pre-populate the repo). |
| `YAAC_E2E_CLAUDE_LOGIN` / `YAAC_E2E_CODEX_LOGIN` / `YAAC_E2E_OPENCODE_LOGIN` | _(unset)_ | Short-circuit the native tool login with a serialized OAuth bundle (claude/codex) or raw api key (opencode). |
| `YAAC_E2E_OPENCODE_PROVIDER` | _(unset)_ | Picks the opencode provider during e2e login (defaults to openrouter). |

The proxy and relay sidecar containers read their own internal variables (`API_PORT`, `PROXY_AUTH_SECRET`, `TRANSPARENT_HTTPS_PORT`, `TRANSPARENT_HTTP_PORT`, `TRANSPARENT_TUNNEL_PORT`, `DNS_STUB_PORT`, `USE_TOR`, and the `KUBERNETES_SERVICE_*` pair). The daemon and cluster inject these when building each pod spec — they are not user-configurable.

## Custom images

The default image (Ubuntu 24.04 + Node.js + pnpm + Claude Code + gh + tmux) can be customized:

- **`Dockerfile.yaac`** — customizes the base image. Behavior depends on the `FROM` line:
  - **Layered (recommended)** — layers on top of the default image. The default Dockerfile is built first, then Dockerfile.yaac is applied on top. Use this to add packages or config while keeping the standard Ubuntu + Node.js + Claude Code environment. Must use `ARG BASE_IMAGE` and `FROM ${BASE_IMAGE}` so the parent image is injected via `--build-arg`:
    ```dockerfile
    ARG BASE_IMAGE
    FROM ${BASE_IMAGE}
    # Rest of Dockerfile...
    ```
  - **Any other `FROM`** — replaces the default image entirely (e.g. use a different base distro or toolchain). Must install Claude Code yourself, since the default Dockerfile is skipped.

  Place at `~/.yaac/projects/<repo-name>/config/Dockerfile.yaac`, or open it in `$EDITOR` with `yaac config edit-dockerfile <project>`.
- **`~/.yaac/Dockerfile.user`** — applied on top of whichever base is used (e.g. nvim config, shell customization). Must use `ARG BASE_IMAGE` and `FROM ${BASE_IMAGE}` so the parent image is injected via `--build-arg`:
  ```dockerfile
  ARG BASE_IMAGE
  FROM ${BASE_IMAGE}
  # Rest of Dockerfile...
  ```

Layer order: default → Dockerfile.tools (agent CLIs; rebuilt by `yaac project rebuild`) → Dockerfile.nestable (only when `nestedContainers` is on) → Dockerfile.yaac (if layered) → Dockerfile.user. A standalone Dockerfile.yaac replaces the default + tools (+ nestable) layers entirely.

## Nested containers and virtual clusters

**`nestedContainers: true`** runs a rootless podman inside the session pod and points the `docker` CLI (and compose) at its Docker-API socket:

- `docker build` / `docker run` / `docker compose up --build` work as-is. Image pulls ride the session's transparent egress to the MITM proxy: the upstream registries (docker.io, ghcr.io, quay.io and their CDNs) are auto-added to the session allowlist, and anything else is denied fail-closed. Build `RUN` steps and nested containers automatically trust the proxy CA.
- Nested containers share the pod's network namespace: a container's listener is reachable on `localhost:<port>` directly (`docker run -p` is a no-op — the app binds the port itself), and container-private networks are unsupported — use `network_mode: host` in compose files.
- Built layers are promoted into a per-project shared store at session teardown, so an identical `docker build` in the next session is a pure cache hit.

**`virtualCluster: true`** additionally gives the session its own kubernetes cluster:

- `kubectl` inside the session is preconfigured (`KUBECONFIG`) against a per-session [vcluster](https://www.vcluster.com/); `kubectl get nodes`, `kubectl run`, deployments, services, and inner NetworkPolicies all work. Pods created in the vcluster actually run on the host cluster, confined to the session: they can reach their own vcluster's API and each other, and nothing else (no host apiserver, no internet — in v1 synced pods have no upstream egress at all).
- A synced-pod admission guard (ValidatingAdmissionPolicy, kubernetes >= 1.30) blocks hostNetwork/hostPID/hostIPC/hostPorts/privileged, restricts hostPath volumes to the session's `nested-yaac` data dir, and requires a user namespace (`hostUsers: false`) for added capabilities. vcluster creation fails closed (with no opt-out) when the VAP API is missing.
- Each project gets a plain-HTTP push registry (`registry:2`) reachable from its sessions as `yaac-reg-<project>.<namespace>.svc:5000` — build an image, `docker push` it there, and `kubectl run` the pushed ref in the vcluster (the node pulls it through a containerd `hosts.toml` mapping). Only the project's own sessions can reach its registry. Stale content-hash tags accumulate until project removal or cluster recreate (registry:2 has no safe online GC).
- Each vcluster costs roughly 0.5Gi of memory, so mind how many vcluster sessions run at once.

**yaac-in-yaac**: vcluster sessions are preset for running yaac itself inside the session — `YAAC_NESTED=1`, `YAAC_DATA_DIR` pointing at a host-visible per-session dir, and `YAAC_K8S_REGISTRY` pointing at the project registry. Supported in v1: the inner unit suite, inner `yaac cluster check` (egress-layer gates skip under `YAAC_NESTED`), and inner non-nested session creation against the vcluster (inner sessions have no upstream egress in v1). Inner yaac refuses `virtualCluster` — no vcluster-in-vcluster.

