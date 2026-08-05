# Yet Another Agent Container

Agent sandbox manager — run many parallel agent sessions, each isolated in its own gVisor sandbox on a k8s cluster. Supports Claude Code, Codex CLI, OpenCode, and Pi.

## Install

### Homebrew (macOS, arm64)

```sh
brew trust bsklaroff/yaac
brew trust libkrun/krun
brew tap libkrun/krun
brew install bsklaroff/yaac/yaac
yaac cluster setup   # podman machine + registry + kind cluster + Calico + netd
```

The formula pulls in the whole toolchain: `node`, `kubectl`,
`podman` (>= 6.0), a pinned `kind` build (`yaac-kind` — see the
[version-skew note](docs/cluster-setup.md#version-skew-podman-6x-needs-a-patched-kind)),
and a patched `krunkit`+`libkrun` pair (`yaac-krunkit`/`yaac-libkrun` —
stock krunkit's virtiofs reports every file as owned by whichever process
asks, which breaks hostPath writes from gVisor session pods; see the
[machine notes](docs/cluster-setup.md#macos-the-podman-machine) and
[#27](https://github.com/bsklaroff/yaac/issues/27)).

### From source (development)

A dev install **replaces** the brew one — both want to own the same
`bin/yaac` symlink, so never keep both installed (`brew uninstall yaac`
first if you have the package; switch back later with
`npm uninstall -g @bsklaroff/yaac && brew install bsklaroff/yaac/yaac`).

#### macOS (arm64)

Install the toolchain the formula would otherwise pull in:

```sh
brew trust bsklaroff/yaac
brew trust libkrun/krun
brew tap libkrun/krun
brew install node pnpm kubernetes-cli podman bsklaroff/yaac/yaac-kind bsklaroff/yaac/yaac-krunkit
```

#### Linux

```sh
# Debian/Ubuntu 26.04+. Note: NOT nodejs/npm from apt — Debian's Node is
# built without the TypeScript type-stripper the frontend build needs
# (see below). Install Node via nvm instead.
sudo apt install podman acl

# Node via nvm: its official builds ship the type-stripper (Node >= 22.18).
# 22.22.2 matches the repo's .nvmrc; pnpm installs into nvm's user-owned
# prefix, so no sudo.
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | bash
export NVM_DIR="$HOME/.nvm" && \. "$NVM_DIR/nvm.sh"   # or just open a new shell
nvm install 22.22.2 && nvm alias default 22.22.2
npm install -g pnpm

curl -fsSLo kind "https://kind.sigs.k8s.io/dl/v0.32.0/kind-linux-$(dpkg --print-architecture)"
sudo install -m 755 kind /usr/local/bin/kind && rm kind
curl -fsSLo kubectl "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/$(dpkg --print-architecture)/kubectl"
sudo install -m 755 kubectl /usr/local/bin/kubectl && rm kubectl

# yaac uses rootful podman on Linux (the calico-node agent needs it); enable the
# socket and grant your user access:
sudo systemctl enable --now podman.socket
sudo setfacl -m u:$USER:x /run/podman
sudo setfacl -m u:$USER:rw /run/podman/podman.sock
```

Don't install Node from apt on Linux: Debian/Ubuntu build their `nodejs`
package without Node's built-in TypeScript type-stripper (Amaro), which the
frontend's Vite build relies on to load its `.ts` config. With the apt build,
`pnpm build` dies at `vite build` with `ERR_NO_TYPESCRIPT` /
`Unknown file extension ".ts"`. nvm installs the official Node binaries, which
enable type-stripping by default (Node >= 22.18), so the build works.

The apt-shipped podman 5.x works fine on Linux and pairs with stock kind
v0.32.0; only podman 6.x needs the pinned kind build (see the
[version-skew note](docs/cluster-setup.md#version-skew-podman-6x-needs-a-patched-kind)).
yaac drives the **rootful** podman engine on Linux — kind's node needs the
host netfilter and routing access that rootless podman doesn't delegate, or the
calico-node DaemonSet hangs (see
[Linux: rootful podman](docs/cluster-setup.md#linux-rootful-podman)).

Give the host **swap** before `yaac cluster setup` if `swapon --show` is
empty. Session pods run under gVisor, which holds the sandboxed workload's
memory in a memfd — shmem, which the kernel cannot reclaim at all without
swap, so a session under pressure is OOM-killed where it would otherwise
have paged out. Create it first: the cluster's kubelet picks up
`swapBehavior: LimitedSwap` (`k8s/kind-config.yaml`) only when kind creates
the node, and no `--repair` adds it later.

```sh
# ext4. On btrfs: sudo btrfs filesystem mkswapfile --size 32G /swapfile
# On ZFS use a zvol, not a swapfile.
sudo fallocate -l 32G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

A pod's share is `memoryRequest / nodeRAM × totalSwap`, so sizing swap at
roughly node RAM gives a session about its memory request again. If you run
swap deep, check that `systemd-oomd` (`SwapUsedLimit=90%` by default) won't
kill the kind node container first.

#### Both platforms

Then build, link, and wire the cluster:

```sh
git clone https://github.com/bsklaroff/yaac.git
cd yaac
pnpm install
pnpm build
npm install -g .      # symlinks the checkout — every pnpm build is live
yaac cluster setup
```

## Web app

yaac ships a local web app — a GUI over the same server the CLI drives.
Launch it with:

```sh
yaac open
```

This starts the server if needed and opens your browser straight into the
authenticated app: a live session sidebar, the project list, and an embedded
terminal (xterm.js) attached to each session's tmux. `yaac open --no-browser`
prints the URL instead of launching a browser.

It's local-first — the server binds `127.0.0.1` only, and the browser
authenticates with an `HttpOnly` cookie obtained from a one-time token
that `yaac open` mints and exchanges for you (no manual pasting). The CLI
and web app drive the same on-disk state, so you can mix them freely.

### Remote access over Tailscale

To reach the server from another device, run it on an always-on machine and
join both to a private [Tailscale](https://tailscale.com) tailnet. The server
keeps binding `127.0.0.1`; a `tailscale serve` proxy terminates TLS on the
tailnet and forwards to it, so remote access is opt-in and off by default —
never expose it with `tailscale funnel`. On the server:

```sh
tailscale up
tailscale serve --bg 8787                            # tailnet-only TLS proxy
export YAAC_ALLOWED_HOSTS=<host>.<tailnet>.ts.net    # admit the tailnet host
export YAAC_TRUST_PROXY=1                            # trust the proxy's TLS
yaac server restart
yaac auth token create laptop                        # per-device token (once)
```

Put the two env vars in the server's permanent environment (a systemd unit
or shell profile) and restart it — a detached restart won't inherit an
interactive `export`. Then browse to `https://<host>.<tailnet>.ts.net` (the
hostname over HTTPS, not `ip:8787`), or point a client CLI at it with
`yaac remote set https://<host>.<tailnet>.ts.net --token <token>`. See
[docs/remote-hosting.md](docs/remote-hosting.md) for the full flow — client
and phone setup, forwarded-port reachability, and the security model.

A session's forwarded ports (a dev server, or a nested yaac's own web UI)
bind the server's loopback by default. To reach them from other tailnet
devices, set `YAAC_FORWARD_BIND` to the server's tailnet IP (from `tailscale
ip -4`) and restart; the webapp's port chips then link to
`http://<host>.<tailnet>.ts.net:<port>`. Those listeners are plain http and
reachable by any tailnet device (not yaac-token-gated), so keep this to a
personal tailnet.

### Desktop app

The same web app is also available as a macOS Electron shell (`@yaac/desktop`).
It has no bundled frontend of its own: the main process resolves the target
server (remote if enabled, else the local daemon — starting one if none is
up), mints the same one-time token `yaac open` does, and loads the server
origin into a native window. It lives in the tray (close hides, Quit stops
only the shell) and badges the dock for waiting sessions. It is not part of
`pnpm build` and never ships in the npm artifact.

No extra prerequisites beyond the repo's `pnpm install` (the `electron` dev
dependency downloads its binary on install); dev runs also need the `yaac`
CLI on PATH for local-server and auth-daemon auto-start. Run it from the repo
root:

```sh
pnpm desktop:dev     # tsup-bundle the main process, then launch electron
pnpm desktop:hot     # same, but the window loads Vite for frontend hot-reload
pnpm desktop:build   # just build the main-process bundle (dist/main.js)
```

To build a standalone (unsigned) macOS `.app`:

```sh
pnpm desktop:package   # build + stage the bundled server → electron-builder (dist-app/)
pnpm desktop:install   # the above, then install into /Applications
```

See [`packages/desktop/README.md`](packages/desktop/README.md) for the boot
and auth flow, packaging internals, and the by-hand verification matrix.

## CLI

```
yaac [command]

Commands:
  open            Open the web app in your browser (starts the server if needed)
  cluster         Manage the kubernetes cluster yaac runs worktrees on
  project         Manage projects
  worktree        Manage worktrees (a git worktree + its container and agents)
  config          Edit project configuration files (via the server)
  auth            Manage credentials (GitHub tokens and tool API keys)
  remote          Point this CLI at a remote yaac server

yaac cluster <command>
  check             Verify cluster prerequisites (kubectl, registry, hostPath wiring)
  setup [--repair]  Create the kind cluster, registry, and CNI wiring
                    (--repair re-applies the node fixups without recreating)
  delete [-y]       Delete the kind cluster and local registry, keeping
                    on-disk worktrees and their checkouts (-y skips confirmation)

yaac project <command>
  list              List all projects
  add <remote-url>  Add a project (HTTPS URL or SSH URL like git@host:path)
  rebuild <project> Rebuild the agent-CLI image layer with --no-cache

yaac worktree <command>
  create [options] <project>  Create a new worktree for a project
    -t, --tool <tool>         Agent tool to use (claude, codex, opencode, or pi)
    -b, --branch <branch>     Reference branch for the worktree (defaults to
                              the project's referenceBranch config, else the
                              remote default branch)
  list [options] [project]    List running worktrees
    -s, --stopped             List stopped worktrees (checkouts are kept)
  stop <worktree-id>          Stop a worktree: tear down its container,
                              keep its checkout and diff
  restart <worktree-id>       Restart a worktree, resuming the agent sessions
                              that were running when it stopped
  agents <worktree-id>        List the worktree's agent sessions (open first)
  attach <container-id>       Attach to the agent tmux session
  shell <container-id>        Open a raw shell in the worktree container
  monitor [options] [project] Poll and display running worktrees in real-time
    -n, --interval <seconds>  Refresh interval in seconds (default: 5)

yaac tool <command>
  get                 Show the current default agent tool
  set <tool>          Set the default agent tool (claude, codex, opencode, or pi)

yaac config <command>
  edit <project>              Open the project's yaac-config.json in $EDITOR
  edit-dockerfile <project>   Open the project's Dockerfile.yaac in $EDITOR
  edit-user-dockerfile        Open the global ~/.yaac/Dockerfile.user in $EDITOR

yaac auth <command>
  list                List configured credentials (masked)
  update              Add or update credentials (GitHub, Claude Code, Codex, OpenCode, or Pi)
  clear               Remove stored credentials (interactive)
  token <command>     Durable access tokens for remote clients
    create <name>       Mint a token (printed once) for a remote client
    list                List tokens (masked)
    revoke <name>       Revoke a token by name
  server <command>    The login broker that runs Claude/Codex sign-ins on this machine
    run|start|stop|status

yaac remote <command>
  set <url> --token <t>  Configure and enable a remote server (verifies the token)
  unset                  Forget the remote (commands target the local server)
  on | off               Toggle the configured remote without re-entering the token
  status                 Show the configured remote (masked token)
```

Detach from a tmux session with `Ctrl-B D`. Kill the tmux session (and the
container) with `Ctrl-B K` (custom binding, not standard tmux). Open a new
shell in the tmux session with `Ctrl-B C`, and switch between shells with `Ctrl-B N` (next) and
`Ctrl-B P` (previous).

## Authentication

yaac centralizes credentials on the host and injects them into session traffic through the shared proxy (a `yaac-proxy` Deployment in the cluster). Real tokens are never written into the container filesystem. Credentials live under `~/.yaac/.credentials/` (directory permissions `0700`, files `0600`), split by service:

- `~/.yaac/.credentials/github.json` — GitHub tokens
- `~/.yaac/.credentials/claude.json` — Claude Code credentials (OAuth bundle or API key)
- `~/.yaac/.credentials/codex.json` — Codex credentials
- `~/.yaac/.credentials/opencode.json` — OpenCode credentials (OpenRouter API key)
- `~/.yaac/.credentials/pi.json` — Pi credentials (OpenRouter, Anthropic, or OpenAI API key)

A worktree is tool-agnostic — it holds whatever agent sessions you open in it,
in any mix — so injection is not scoped to one tool: **any agent in any
worktree can spend any credential the host has signed in**. The proxy only
rewrites requests carrying the placeholder sentinel it put in the container's
env, so traffic you authenticate yourself passes through untouched.

The proxy pod mounts this directory RW (hostPath) and reads credentials at request time, so updates via `yaac auth update` propagate to every running session immediately without needing to restart pods. The proxy is reachable only inside the cluster (ClusterIP Service); the server talks to it over a loopback exec tunnel (`kubectl exec` + socat, which works regardless of the pod's runtime tier).

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

yaac also manages the API credentials for the agent tool itself, so Claude Code, Codex, OpenCode, and Pi don't need to authenticate inside each container. On first run (or via `yaac auth update`), yaac runs the tool's native login flow on the host and stores the resulting credentials. OpenCode is API-key only (OpenRouter): the key stays on the host and the proxy swaps the in-container placeholder on requests to openrouter.ai. Pi is likewise API-key only, against a chosen provider (OpenRouter, Anthropic, or OpenAI): the key stays on the host and the proxy swaps the in-container placeholder on requests to that provider's host (as `Authorization: Bearer`, or `x-api-key` for Anthropic).

For Claude Code OAuth, each project's `.claude/.credentials.json` inside the container holds placeholder tokens (`yaac-ph-access` / `yaac-ph-refresh`) together with the real `expiresAt` and scopes. The proxy transparently rewrites outbound API calls, swaps the placeholder refresh token on refresh requests, and writes refreshed bundles back to the host file — so real tokens never enter the container filesystem. For API-key mode the proxy injects the key as an outbound header.

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
| `~/.yaac/projects/<project>/pi-sessions/<session-id>` | `/home/yaac/.pi/agent/sessions` | Pi session logs (per session) |
| `~/.yaac/projects/<project>/.cached-packages` | `/home/yaac/.cached-packages` | Per-project package-manager caches |

The session container runs as user `yaac` with home directory `/home/yaac`. All project data is stored under `~/.yaac/projects/<repo-name>/` on the host — which is why the cluster node must have your home directory extraMounted (see [Cluster setup](docs/cluster-setup.md#what-it-wires-up)). The repo plus the Claude and Codex state directories are shared across all sessions within a project (but isolated between projects), so those sessions can inspect each other's history; OpenCode and Pi session data are per-session (OpenCode to avoid concurrent-write issues in its database, Pi so `pi --continue` resumes only that session's log). Each session gets its own git worktree.

The `.cached-packages` directory is shared by every session within the project, so package-manager caches survive session teardown and are reused across sessions. pnpm's default `store-dir` is pre-configured to `/home/yaac/.cached-packages/pnpm-store`, so `pnpm install` populates the per-project store automatically with no extra configuration.

## Project configuration

Per-machine, per-project configuration lives under each project's data dir:

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
  "hideInitPane": false,
  "referenceBranch": "develop"
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
- **cacheVolumes** — per-project persistent cache directories mounted into the container. Keys are cache names (backed by `~/.yaac/projects/<project>/cache-volumes/<name>` on the host), values are absolute container paths. Caches persist across sessions. Note: a per-project `~/.yaac/projects/<project>/.cached-packages` directory is already bind-mounted at `/home/yaac/.cached-packages` on every container for pnpm (and other package-manager caches you want to share across sessions), so you don't need a `cacheVolumes` entry for pnpm's store.
- **initCommands** — commands run inside the container after it starts (e.g. `pnpm install` against the warm shared cache). These run on every session, not just the first. Accepts two shapes (cannot be mixed):
  - **String list** — all commands are chained with `&&` and run in a single tmux window named `init`, parallel to the agent:
    ```json
    "initCommands": ["pnpm install", "pnpm build"]
    ```
  - **Object list** — one tmux window per entry, so multiple long-running processes (e.g. a backend and a frontend dev server) run in parallel and can be inspected independently. Each entry has a `name` (the tmux window name; must not collide with the agent window — `claude` / `codex` / `opencode` / `pi` / `init` / `yaac` are reserved), a `commands` array (chained with `&&` inside that window), and an optional `hidePane` that overrides the top-level `hideInitPane` for this window. Windows are spawned independently, so any shared setup (e.g. `pnpm install`) should be listed in each window that needs it:
    ```json
    "initCommands": [
      { "name": "backend",  "commands": ["pnpm install", "pnpm dev:backend"] },
      { "name": "frontend", "commands": ["pnpm install", "pnpm dev:frontend"] }
    ]
    ```
- **hideInitPane** — when `true`, the init commands tmux pane is automatically closed after the commands finish or error (default: `false`). When `false`, the pane is preserved with `remain-on-exit` so you can inspect the output.
- **addAllowedUrls** — additional host patterns to allow on top of the [default allowlist](packages/server/src/lib/container/default-allowed-hosts.ts). By default, the proxy blocks outbound requests to hosts not on the default list. (How a session's traffic reaches the proxy in the first place, and why it fails closed: [Session egress](docs/session-egress.md).) Use this to add extra hosts without replacing the defaults. Supports exact hostnames (`api.example.com`) and wildcards (`*.example.com`).
- **setAllowedUrls** — completely replaces the default allowlist with the given list of host patterns. Cannot be used together with `addAllowedUrls`. Set to `["*"]` to allow all outbound URLs (disables filtering), or `[]` to block all external network access. If the resolved list does not include `api.anthropic.com` or `github.com`, a warning is printed since sessions require these to function.
- **nestedContainers** — run an in-pod rootless podman so `docker build` / `docker run` / `docker compose up --build` work inside the session exactly as a project README instructs (the `docker` CLI talks to podman's Docker-API socket). See [Nested containers and virtual clusters](#nested-containers-and-virtual-clusters).
- **virtualCluster** — give each session its own virtual kubernetes cluster (vcluster) plus a per-project push registry. Implies `nestedContainers` (setting `"nestedContainers": false` alongside it is a config error).
- **referenceBranch** — the branch on `origin` (no `origin/` prefix) that new session worktrees are created from and set upstream to. Unset → the remote's default branch. A per-create pick overrides it: `yaac worktree create --branch <branch>`, or the branch typeahead in the webapp's new-session popover (which can also pin a new default). Changing it affects new sessions only — existing worktrees keep their base, and prewarmed spares are re-pointed at claim time rather than invalidated.

## Environment variables

Every yaac variable is read in one place — [`packages/shared/src/env.ts`](packages/shared/src/env.ts) — which owns its default and validation. The rest of the codebase imports the typed `env` / `testEnv` accessors instead of touching `process.env`.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `YAAC_DATA_DIR` | `~/.yaac` | Data directory holding projects, sessions, and the server lock. |
| `YAAC_SERVER_PORT` | `8787` | Port the server binds on `127.0.0.1` (auto-increments if busy). `0` requests an OS-assigned ephemeral port. |
| `YAAC_USE_TOR` | `false` | Route the server's host-side git/ssh through a Tor SOCKS proxy. Off when unset/empty/`0`/`false`; any other value is on. |
| `YAAC_HOST_TOR_SOCKS_URL` | `socks5h://127.0.0.1:9050` | SOCKS endpoint used when `YAAC_USE_TOR` is on. |
| `YAAC_K8S_REGISTRY` | `localhost:5001` | `host:port` of the local OCI registry the cluster pulls session images from. |
| `YAAC_KIND_CLUSTER` | `yaac` | Name of the kind cluster `yaac cluster setup` creates/repairs. |
| `YAAC_PREWARM_POOL_SIZE` | `1` | Prewarmed sessions kept ready per active project (`0` disables prewarming). |
| `YAAC_NESTED` | _(unset)_ | Set to `1` automatically by the server inside a nested (vcluster) session — not something you set yourself. |
| `YAAC_ALLOWED_HOSTS` | _(unset)_ | Comma-separated extra hostnames the server's Host-header check admits (e.g. its tailnet name behind `tailscale serve`). Loopback is always allowed. |
| `YAAC_TRUST_PROXY` | _(unset)_ | `1` when the server runs behind a trusted TLS-terminating proxy: trusts `X-Forwarded-Proto` to mark the session cookie `Secure`. |
| `YAAC_FORWARD_BIND` | `127.0.0.1` | Bind address for session port-forward listeners; a remote-hosting server sets its tailnet IP so forwarded dev servers are reachable from other devices. |
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
| `YAAC_SERVER_URL` / `YAAC_SERVER_SECRET` | _(unset)_ | Point the CLI at an in-process server without the lock file (tests). |
| `YAAC_E2E_NO_ATTACH` | _(unset)_ | `1` skips the post-provision terminal attach (no-TTY e2e). |
| `YAAC_E2E_SKIP_FETCH` | _(unset)_ | `1` skips the host-side git fetch during create (e2e fixtures pre-populate the repo). |
| `YAAC_E2E_CLAUDE_LOGIN` / `YAAC_E2E_CODEX_LOGIN` / `YAAC_E2E_OPENCODE_LOGIN` / `YAAC_E2E_PI_LOGIN` | _(unset)_ | Short-circuit the native tool login with a serialized OAuth bundle (claude/codex) or raw api key (opencode/pi). |
| `YAAC_E2E_OPENCODE_PROVIDER` | _(unset)_ | Picks the opencode provider during e2e login (defaults to openrouter). |
| `YAAC_E2E_PI_PROVIDER` | _(unset)_ | Picks the pi provider during e2e login (defaults to openrouter). |

The proxy and relay sidecar containers read their own internal variables (`API_PORT`, `PROXY_AUTH_SECRET`, `TRANSPARENT_HTTPS_PORT`, `TRANSPARENT_HTTP_PORT`, `TRANSPARENT_TUNNEL_PORT`, `DNS_STUB_PORT`, `USE_TOR`, and the `KUBERNETES_SERVICE_*` pair). The server and cluster inject these when building each pod spec — they are not user-configurable.

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
- A synced-pod admission guard (ValidatingAdmissionPolicy, kubernetes >= 1.30) blocks hostNetwork/hostPID/hostIPC/hostPorts/privileged, restricts hostPath volumes to the session's `nested-yaac` data dir, and requires the gVisor runtime tier (the sentry) for added capabilities. vcluster creation fails closed (with no opt-out) when the VAP API is missing.
- Each project gets a plain-HTTP push registry (`registry:2`) reachable from its sessions as `yaac-reg-<project>.<namespace>.svc:5000` — build an image, `docker push` it there, and `kubectl run` the pushed ref in the vcluster (the node pulls it through a containerd `hosts.toml` mapping). Only the project's own sessions can reach its registry. Stale content-hash tags accumulate until project removal or cluster recreate (registry:2 has no safe online GC).
- Each vcluster costs roughly 0.5Gi of memory, so mind how many vcluster sessions run at once.

**yaac-in-yaac**: vcluster sessions are preset for running yaac itself inside the session — `YAAC_NESTED=1`, `YAAC_DATA_DIR` pointing at a host-visible per-session dir, and `YAAC_K8S_REGISTRY` pointing at the project registry. Inner yaac refuses `virtualCluster` — no vcluster-in-vcluster.

