# Yet Another Agent Container

yaac runs many agent sessions in parallel, each in its own workspace: a git
clone of your project with one or more agents working in it. It supports
Claude Code, Codex CLI, OpenCode and Pi, and you drive it from a CLI, a local
web app, or a macOS desktop app.

A workspace runs on one of two drivers:

- **k8s**: each workspace is a pod in a local kind cluster, sandboxed with
  gVisor, built from an image, and reaching the network only through an
  egress proxy that holds your real credentials. Set it up with
  `yaac cluster install`.
- **containerless**: each workspace is a tmux server on your machine, in its
  own checkout. No cluster, no image and no sandbox: agents run as you, with
  your access and real credentials. Set it up with `yaac server start`
  ([docs/containerless-driver.md](docs/containerless-driver.md)).

You don't pick the driver with a flag. `yaac cluster install` runs the server
as a pod in the cluster, which means k8s; `yaac server start` runs it as a
process on your machine, which means containerless. One data dir is one or the
other, and yaac refuses to mix them.

## Install

### Homebrew (macOS, arm64)

```sh
brew trust bsklaroff/yaac
brew trust libkrun/krun
brew tap libkrun/krun
brew install bsklaroff/yaac/yaac
yaac cluster install   # k8s: the cluster, CNI, registry and every image yaac ships
# or, for containerless:
yaac server start && yaac host check
```

The formula installs `node`, `kubectl`, `podman` (6.0 or newer), `kind`
(v0.33.0 or newer; see the
[version note](docs/cluster-setup.md#kind-and-kubernetes-versions)), a patched
`krunkit`/`libkrun` pair, and what the containerless driver needs on the host
(`tmux`, `socat`, `fd`, `ripgrep`). The patched pair exists because stock
krunkit reports every file as owned by whoever reads it, which breaks gVisor
pods writing to host directories (see the
[machine notes](docs/cluster-setup.md#macos-the-podman-machine) and
[#27](https://github.com/bsklaroff/yaac/issues/27)). Under containerless, yaac
installs its pinned agent CLIs itself with npm; `yaac host check` shows what
the host still lacks.

Upgrading from an install that used `yaac-kind` or the old `virglrenderer`
formula takes two one-time steps first (why:
[homebrew/README.md](homebrew/README.md#migrating-an-existing-install)):

```sh
brew uninstall --ignore-dependencies yaac-kind && brew install kind && brew link kind
brew uninstall --ignore-dependencies virglrenderer && brew upgrade yaac-libkrun
```

### From source

A source install replaces the brew one, since both own the same `bin/yaac`
link. Run `brew uninstall yaac` first if you have it. To switch back later:
`npm uninstall -g @bsklaroff/yaac && brew install bsklaroff/yaac/yaac`.

#### macOS (arm64)

```sh
brew trust bsklaroff/yaac
brew trust libkrun/krun
brew tap libkrun/krun
brew install node pnpm kubernetes-cli podman kind bsklaroff/yaac/yaac-krunkit
brew install tmux socat fd ripgrep   # for the containerless driver
```

#### Linux

```sh
# Debian/Ubuntu. libgomp1 is the OpenMP runtime the bundled llama.cpp
# (workspace titles) needs; yaac fetches it itself if missing.
sudo apt install podman acl libgomp1
sudo apt install tmux socat fd-find ripgrep   # for the containerless driver

# Node from nvm, not apt (see below). 22.22.2 matches .nvmrc.
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | bash
export NVM_DIR="$HOME/.nvm" && \. "$NVM_DIR/nvm.sh"   # or open a new shell
nvm install 22.22.2 && nvm alias default 22.22.2
npm install -g pnpm

curl -fsSLo kind "https://kind.sigs.k8s.io/dl/v0.33.0/kind-linux-$(dpkg --print-architecture)"
sudo install -m 755 kind /usr/local/bin/kind && rm kind
curl -fsSLo kubectl "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/$(dpkg --print-architecture)/kubectl"
sudo install -m 755 kubectl /usr/local/bin/kubectl && rm kubectl

# yaac uses rootful podman on Linux. Enable its socket and give your user access:
sudo systemctl enable --now podman.socket
sudo setfacl -m u:$USER:x /run/podman
sudo setfacl -m u:$USER:rw /run/podman/podman.sock
```

- **Node:** Debian and Ubuntu build `nodejs` without Node's TypeScript type
  stripping, which the frontend's Vite build needs to load its `.ts` config.
  With apt's Node, `pnpm build` fails at `vite build` with
  `ERR_NO_TYPESCRIPT`. nvm's official builds have it (Node 22.18 or newer).
- **podman:** apt's podman 5.x is fine. yaac uses the rootful engine because
  kind's node needs host netfilter and routing access that rootless podman
  doesn't grant; without it the calico-node pods hang (see
  [Linux: rootful podman](docs/cluster-setup.md#linux-rootful-podman)).
- **Swap:** if `swapon --show` prints nothing, add swap before
  `yaac cluster install`. gVisor keeps a workspace's memory in shared memory,
  which the kernel can only reclaim by swapping, so without swap a workspace
  under memory pressure is OOM-killed. The kubelet only enables swap
  (`LimitedSwap` in `k8s/kind-config.yaml`) when kind creates the node, so
  add swap first.

  ```sh
  # ext4. On btrfs: sudo btrfs filesystem mkswapfile --size 32G /swapfile
  # On ZFS, use a zvol instead of a swapfile.
  sudo fallocate -l 32G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  ```

  Each pod gets `memoryRequest / nodeRAM × totalSwap`, so swap about the size
  of RAM gives a workspace roughly its memory request again. If you use swap
  heavily, check that `systemd-oomd` (`SwapUsedLimit=90%` by default) won't
  kill the kind node container first.

#### Build and set up

```sh
git clone https://github.com/bsklaroff/yaac.git
cd yaac
pnpm install
pnpm build
npm install -g .      # links the checkout, so every pnpm build is live
yaac cluster install  # or: yaac server start
```

## Getting started

```sh
yaac auth update                              # sign in an agent tool, add a git credential
yaac project add <remote-url> <credential>    # clone a project with that credential
yaac workspace create <project> -p "<prompt>" # start a workspace and attach to it
```

Or do all of this in the web app. Its address is the `url` line of
`yaac remote status`.

## Web app

The web app shows a live list of workspaces, the projects, a terminal
(xterm.js) or chat pane for each agent, and settings. It is served by the same
server the CLI talks to, and both work on the same state, so you can mix them.

By default the server answers only at a `127.0.0.1` address. A request there
comes from the machine's owner and needs no credential. Over Tailscale
(below), the server asks the tailnet who the caller is, so there is still no
token to paste.

### Remote access over Tailscale

To use yaac from other devices, run the server on an always-on machine and put
both on a private [Tailscale](https://tailscale.com) tailnet. Remote access is
off until you set it up. Never expose the server with `tailscale funnel`.

Containerless: put a `tailscale serve` proxy in front of the server and allow
its tailnet hostname.

```sh
tailscale up
tailscale serve --bg https / http://127.0.0.1:8787
export YAAC_ALLOWED_HOSTS=<host>.<tailnet>.ts.net
yaac server restart
```

Put `YAAC_ALLOWED_HOSTS` in the server's permanent environment (a systemd unit
or shell profile); a background restart doesn't inherit an interactive
`export`.

k8s: install with `--tailnet`. The Tailscale Kubernetes operator (installed
beforehand) publishes the server at `https://yaac.<tailnet>.ts.net`, and
install sets the allowed host on the server itself.

```sh
yaac cluster install --tailnet
```

Then browse to that `https://….ts.net` origin, or point another machine's CLI
at it with `yaac remote set <origin>`. Each request is identified by the
tailnet user it comes from, so the device must be logged in to the tailnet as
a user (tagged devices are refused). On a shared tailnet,
an ACL grant decides who can reach the server. Revoke a lost device in the
Tailscale admin console.

A workspace's forwarded ports (a dev server, say) are offered by the server
but bound on a client, by `yaac forward` or the desktop app
([docs/port-forward-tunnel.md](docs/port-forward-tunnel.md)). To reach them
from other tailnet devices, run `yaac forward --bind <tailnet IP>` on the
server machine (the IP from `tailscale ip -4`), and set `YAAC_FORWARD_BIND` to
the same address so the web app links to it. Set that variable the same way as
`YAAC_ALLOWED_HOSTS`: restart a containerless server, or re-run
`yaac cluster install` from a shell that exports it. These ports are plain HTTP
and reachable by any device on the tailnet, so only do this on a personal
tailnet.

See [docs/remote-hosting.md](docs/remote-hosting.md) for bring-your-own
clusters, phone setup and the security model.

### Desktop app

`@yaac/desktop` is a macOS Electron shell around the web app. It loads the
selected server's web app into a native window, lives in the tray (closing
hides it; Quit stops only the shell), badges the dock when workspaces are
waiting, and forwards workspace ports on this machine. It never starts a
server, so run `yaac server start` or `yaac cluster install` first. It is not
part of `pnpm build` or the npm package.

```sh
pnpm desktop:dev       # build the main process and launch Electron
pnpm desktop:hot       # same, with Vite hot reload for the frontend
pnpm desktop:package   # build an unsigned .app into dist-app/
pnpm desktop:install   # build it and install into /Applications
```

Dev runs need the `yaac` CLI on PATH. See
[packages/desktop/README.md](packages/desktop/README.md) for details.

## CLI

`yaac <command> --help` shows every option. A `<workspace-id>` can be a unique
prefix of the id.

```
yaac server                     The yaac server the CLI and web app talk to
  start | stop | restart        Under k8s these scale or roll the in-cluster server
  run [-p <port>]               Run in the foreground (what `start` runs)
  logs [-f] [-n <lines>]        Print the server log

yaac cluster                    The Kubernetes cluster (k8s driver only)
  check                         Verify prerequisites and wiring
  install                       Create or converge the cluster, images and server.
                                Safe to re-run; never destructive
    --nodes <count>             kind nodes to create (default 1, max 5;
                                ignored if the cluster exists)
    --tailnet                   Publish the server on your tailnet via the
                                Tailscale Kubernetes operator
    --byo                       Install into the cluster your kubeconfig points
                                at instead of creating one (published on the tailnet)
    --rwx-storage-class <name>  With --byo (required): NFS-family class for the
                                shared claim
    --rwo-storage-class <name>  With --byo: class for the server's own claim
                                (default: the cluster's default class)
  delete [-y]                   Delete the kind cluster and its registry; keeps
                                workspaces' checkouts. Refused on a --byo install

yaac host check                 Verify this machine can run containerless workspaces

yaac project
  list
  add <remote-url> <credential> Clone a project (HTTPS or git@host:path) with the
                                named git credential (see `yaac auth list`)

yaac workspace
  create <project>              Create a workspace and attach to its agent
    -t, --tool <tool>           claude, codex, opencode or pi (default: the
                                project's last, else claude)
    -b, --branch <branch>       Base branch (default: the remote's default)
    -p, --prompt <text>         Initial prompt for the agent
    -m, --model <model>         Model id or alias (provider/model for opencode, pi)
    --mode <tui|acp>            Terminal UI, or chat pane over ACP
                                (docs/agent-modes.md)
    --permission-mode <mode>    bypass, auto, accept-edits, manual, plan or
                                read-only (docs/permission-modes.md)
    -g, --group <group>         File it under a sidebar group (created if new)
  list [project]                List running workspaces
    -s, --stopped               List stopped ones instead
    -n, --num <n>               With -s, show at most n (default 25)
    -a, --all                   With -s, show all
  rename <workspace-id> <title>
  stop <workspace-id>           Tear down the runtime; keep the checkout and diff
  restart <workspace-id>        Restart, resuming the agents that were running
  agents <workspace-id>         List the workspace's agent sessions
  attach <workspace-id>         Attach to the workspace's tmux session
  shell <workspace-id>          Open a shell in the workspace
  monitor [project]             Live table of running workspaces
    -n, --interval <seconds>    Refresh interval (default 5)

yaac group                      Named sidebar groups of workspaces
  create <project> <name>
  list [project]
  move <workspace-id> [group]   Omit the group to ungroup
    --project <slug>            Required for a stopped workspace
  delete <project> <group>      Its workspaces return to the default list

yaac forward [workspace-id]     Bind a workspace's forwarded ports here (all
                                running workspaces if omitted); runs until stopped
  -p, --port <container[:host]> Forward this port instead (repeatable)
  -b, --bind <address>          Address to bind (default 127.0.0.1)

yaac config
  edit <project>                Edit the project's yaac-config.json in $EDITOR
  edit-dockerfile <project>     Edit the project's Dockerfile.yaac
  edit-user-dockerfile          Edit the global Dockerfile.user
  git-identity                  Show the git identity workspaces commit as
    --name <name> --email <email>  Set it

yaac auth
  list                          List credentials (masked; git credentials by name)
  update                        Add a git credential or sign in an agent tool
  clear                         Remove stored tool credentials
  fake <kinds...>               Seed placeholder credentials for yaac-in-yaac:
                                claude-oauth, opencode-openrouter, pi-openrouter, github
  server start|stop|status|run  The login broker that runs Claude/Codex
                                sign-ins on this machine

yaac remote                     Which server this machine's clients use
  set <url>                     Select a server (checks it identifies this device)
  off | on                      Deselect / reselect it without forgetting it
  unset                         Forget every saved server
  status                        Show the selected server and saved ones
```

In a workspace's tmux session: `Ctrl-B D` detaches, `Ctrl-B C` opens a new
shell, `Ctrl-B N` / `Ctrl-B P` switch windows, and `Ctrl-B k` stops the
workspace after a confirmation.

## Credentials

### Agent tools

`yaac auth update` (or the web app) runs each tool's own sign-in and stores
the result with the server, under `~/.yaac/server-local/.credentials/`. Claude
Code and Codex use OAuth; OpenCode uses an OpenRouter API key; Pi uses an API
key for OpenRouter, Anthropic or OpenAI. The browser sign-ins run on your
machine through the auth server (`yaac auth server`), which the desktop app
and `yaac auth update` start for you.

Under **k8s**, real tokens never enter a workspace. Workspaces get placeholder
values, and the shared egress proxy (the `yaac-proxy` Deployment) swaps in the
real token on outgoing requests. For Claude OAuth it also handles token
refresh and saves the refreshed tokens on the server. The proxy only rewrites
requests that carry its placeholder, so traffic you authenticate yourself
passes through untouched. Credential changes reach running workspaces
immediately.

Workspaces are not tied to one tool, so any agent in any workspace can use any
tool credential you have signed in.

Under **containerless**, there is no proxy, so workspaces get the real
credentials. The server keeps refreshed tokens in sync between workspaces
(docs/containerless-driver.md).

### Git identity

Workspaces commit under one server-wide git identity. When the auth server
starts and the server has none, it fills it from your git config. Otherwise
workspace create is refused until you set it in the web app (Settings →
General) or with `yaac config git-identity --name <name> --email <email>`.

### Git credentials

Each project uses one named git credential for all its git operations: the
server's clones and fetches, and every fetch and push from its workspaces.
One credential can serve many projects. There are two kinds:

- **HTTPS token:** a personal access token you paste in, for `https://`
  remotes.
- **SSH key:** a key yaac generates, for `git@host:path` remotes. You only see
  the public half, which you add to the git host as a deploy key or account
  key.

Manage them in the web app under **Settings → Git credentials**: add, rename,
**Replace** (swap in a new token or key, keeping its projects), or **Delete**
(its projects are left without one). From the CLI, `yaac auth update` adds one
and `yaac auth list` shows the names. A project without a credential can't
create workspaces; its create button reads "Add git authentication…".

Under k8s a git credential never enters a workspace. The proxy adds the
project's token to its HTTPS git and `github.com`/`api.github.com` requests,
and signs with its SSH key through a forwarded agent that offers each
workspace only its own project's key. See
[docs/git-credentials.md](docs/git-credentials.md).

## Workspace storage

The data dir (`~/.yaac`) has three tiers:

- `global/`: shared by the server and every workspace, such as project
  clones, checkouts, agent config and history.
- `node-local/`: per-node caches and working copies.
- `server-local/`: the server's own state, such as the database,
  credentials, secret key and log.

A client machine keeps its own state (the selected server, the auth daemon
lock) in `~/.yaac-client`.

Under `global/projects/<project>/`:

| Path | In the workspace | Holds |
|------|------------------|-------|
| `workspaces/<id>` | `/workspace` | The workspace's checkout, a clone that borrows objects from `repo/` |
| `repo/` | read-only | The project's main clone |
| `claude/`, `codex/`, `pi/`, `opencode-config/` | the tool's home or config dir | Agent config, shared by the project's workspaces |
| `history/<id>/` | mounted over the tool homes | Each workspace's own conversations and transcripts |
| `config/` | none | `yaac-config.json` and the image build context |

Package-manager caches live per node in `.cached-packages`, shared by a
project's workspaces on that node. Under k8s, pnpm installs go through the
install's npm cache (a Verdaccio that `yaac cluster install` deploys), and each
pod keeps its own pnpm store, so `pnpm install` needs no setup. Details:
[docs/workspace-storage.md](docs/workspace-storage.md).

## Project configuration

Each project has a `yaac-config.json` and an optional `Dockerfile.yaac`.
Edit them in the web app or with `yaac config edit <project>` and
`yaac config edit-dockerfile <project>`. Both are stored on the server, so this
works against a remote server too. An example:

```json
{
  "cacheVolumes": { "pip-cache": "/home/yaac/.cache/pip" },
  "initCommands": ["pnpm install"],
  "portForward": [{ "containerPort": 3000, "hostPortStart": 3000 }],
  "addAllowedUrls": ["internal.corp.example.com", "*.mycdn.example.com"],
  "hideInitPane": false
}
```

- **initCommands:** commands run in every workspace after it starts. Two forms,
  which can't be mixed:
  - A list of strings, chained with `&&` in one tmux window named `init`.
  - A list of `{ "name", "commands", "hidePane"? }` objects, each in its own
    tmux window, so several long-running processes (a backend and a frontend
    dev server, say) run side by side. Windows run independently, so repeat
    shared setup such as `pnpm install` in each. Names must not be an agent
    tool's name, `init` or `yaac`.
- **hideInitPane:** close init windows when their commands finish (default
  `false`, which keeps them open to inspect the output).
- **portForward:** ports to forward from every workspace. Each entry maps a
  `containerPort` to a host port chosen from `hostPortStart` up. The web app
  also offers to forward ports it sees a workspace listening on
  ([docs/auto-forward-ports.md](docs/auto-forward-ports.md)).
- **cacheVolumes:** named directories that persist across workspaces. Keys
  are names (stored at `global/projects/<project>/cache-volumes/<name>`),
  values are absolute paths in the workspace.
- **addAllowedUrls:** hosts to allow in addition to the proxy's default
  allowlist (`DEFAULT_ALLOWED_HOSTS` in `packages/server/src/lib/allowed-hosts.ts`).
  Exact names (`api.example.com`) or wildcards (`*.example.com`). k8s only; see
  [docs/workspace-egress.md](docs/workspace-egress.md).
- **setAllowedUrls:** replace the default allowlist entirely. Can't be combined
  with `addAllowedUrls`. `["*"]` allows everything; `[]` blocks all external
  access. yaac warns if the list leaves out `api.anthropic.com` or
  `github.com`.
- **nestedContainers:** run a container engine inside the workspace so
  `docker build`, `docker run` and `docker compose` work. See
  [Nested containers](#nested-containers).
- **npmCache:** whether workspaces use the install's npm cache (k8s only;
  default `true`). With `false`, pnpm goes to npmjs through the proxy. A
  project's own `.npmrc` `registry=` wins either way.
- **ephemeralModulesPaths:** dependency directories (relative to the checkout)
  that live with the workspace's runtime instead of the shared checkout, and
  are removed at stop. Default `["node_modules"]`; `[]` turns it off.

**Environment variables and secrets** are not in this file. Set them in the web
app under Settings → Project Config → Environment. A plain variable is placed
in every workspace's environment. A secret is stored encrypted. Under k8s its
value never enters the workspace: the workspace gets a placeholder, and the
proxy swaps in the real value on requests matching the rule you give (hosts,
an optional path glob, and where it goes: a header, `authorization` with a
`Bearer ` prefix by default, or a form/JSON body field). Under containerless
the real value goes into the environment. GitHub access comes from the
project's HTTPS git credential, so you don't need a `GITHUB_TOKEN` secret.

There is no way to mount a host directory into a workspace, since a client on
another machine can't name a path on the server. Use `cacheVolumes`, or bake
the files into the image.

## Secrets at rest

Every secret the server stores is encrypted in its database: project secrets,
git HTTPS tokens, and the SSH private keys yaac generates. The cipher is
[better-auth](https://better-auth.com)'s `symmetricEncrypt`: XChaCha20-Poly1305
with a random nonce per value, keyed by the SHA-256 of a secret string, in a
versioned envelope so keys can be rotated without re-encrypting.

By default the server generates its key at `~/.yaac/server-local/secret.key`
(mode 0600). **Back it up with the data dir.** Without it every stored secret
is unreadable and must be entered again. To keep the key elsewhere, set
`YAAC_SECRET`, or `YAAC_SECRETS` for a versioned set:

```sh
# Rotate: the new key first, then the old one so existing values still open.
export YAAC_SECRETS="1:$(openssl rand -base64 32),0:$(cat ~/.yaac/server-local/secret.key)"
```

## Environment variables

All yaac variables are read, with their defaults and validation, in
[`packages/shared/src/env.ts`](packages/shared/src/env.ts). The ones you might
set:

| Variable | Default | Description |
|----------|---------|-------------|
| `YAAC_DATA_DIR` | `~/.yaac` | Data directory. Client state goes in the sibling `<dir>-client`. |
| `YAAC_SERVER_PORT` | `8787` | Port the server listens on at `127.0.0.1` (the next free one if taken; `0` for any). Under k8s it is fixed when kind creates the cluster. |
| `YAAC_SERVER_URL` | _(unset)_ | Server to use, overriding the selection in `server.json`. |
| `YAAC_ALLOWED_HOSTS` | _(unset)_ | Comma-separated hostnames the server accepts besides loopback, such as its tailnet name. Requests to them must come through `tailscale serve`. |
| `YAAC_FORWARD_BIND` | `127.0.0.1` | Address the web app says forwarded ports are at. Match it with `yaac forward --bind`. |
| `YAAC_SECRET` / `YAAC_SECRETS` | _(unset)_ | Encryption key(s) for stored secrets; see "Secrets at rest". `YAAC_SECRETS` is `"<version>:<secret>,…"`, newest first. |
| `YAAC_USE_TOR` | `false` | Route the server's git and ssh through Tor, and under k8s every workspace's egress too. Off when unset, empty, `0` or `false`. |
| `YAAC_HOST_TOR_SOCKS_URL` | `socks5h://127.0.0.1:9050` | Tor SOCKS endpoint. |
| `YAAC_KIND_CLUSTER` | `yaac` | Name of the kind cluster `yaac cluster install` manages. |
| `YAAC_PREWARM_POOL_SIZE` | `1` | Workspaces kept started ahead of time per active project (`0` disables). |
| `YAAC_IMAGE_PREWARM` | on | Build project images in the background. Off when empty, `0` or `false`. |
| `YAAC_AUTO_TITLES` | on | Generate titles for untitled workspaces with a local model. Off when empty, `0` or `false`. |
| `EDITOR` / `VISUAL` | `vi` | Editor for `yaac config edit*` (`$EDITOR`, then `$VISUAL`, then `vi`). |

Every workspace gets `YAAC_WORKSPACE_ID` set automatically. The other variables
in `env.ts` are set by the build, the server's own Deployment, or the test
harness.

## Custom images (k8s)

The default workspace image is Ubuntu 24.04 with Node.js, gh, tmux and the
agent CLIs. Two files customize it:

- **`Dockerfile.yaac`** (per project, `yaac config edit-dockerfile <project>`).
  - **Layered (recommended):** built on top of the default image. It must
    start with:
    ```dockerfile
    ARG BASE_IMAGE
    FROM ${BASE_IMAGE}
    ```
  - **Standalone:** any other `FROM` replaces the default image entirely. You
    must then install the agent CLIs yourself and create the user as
    described below.
- **`Dockerfile.user`** (global, `yaac config edit-user-dockerfile`): applied
  last, on top of every project's image, for things like editor or shell
  config. It must use the same `ARG BASE_IMAGE` / `FROM ${BASE_IMAGE}` header.

Build order: default, then the agent CLI layer (`Dockerfile.tools`), then
`Dockerfile.nestable` (only with `nestedContainers`), then a layered
`Dockerfile.yaac`, then `Dockerfile.user`. A standalone `Dockerfile.yaac`
replaces the first three.

### The uid rule for custom layers

The images create a `yaac` user with uid 1000 whose primary group is 0, but
the pod may run as a different uid (on a kind install, the owner of your data
dir, which is 501 on macOS). The pod reaches the image's files through group
0, so everything your layer writes must be group-writable. Put `umask 002` in
front of each step that writes under `/home/yaac`:

```dockerfile
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN umask 002 && npm install -g my-tool
```

Without it the step works on a Linux host with uid 1000 and fails with
`Permission denied` elsewhere. Fixing permissions afterwards with
`chgrp -R 0 && chmod -R g=u` is not a substitute: it copies every file it
touches into a new layer.

There is no `yaac` group, so write `chown yaac:0` or `COPY --chown=yaac:0`,
not `yaac:yaac`.

A **standalone** `Dockerfile.yaac` must set all this up itself:

- create the user with primary group 0 (`useradd -m -u 1000 -g 0 ...`);
- make its home group-writable (`chmod -R g=u /home/<user>`);
- make `/etc/passwd` group-writable (`chgrp 0 /etc/passwd && chmod g=u /etc/passwd`)
  so yaac can point the user's entry at the running uid. Without that, `sudo`
  and git over ssh fail in the workspace.

If a standalone image sets its own `ENTRYPOINT`, the entrypoint must not rely
on the `yaac` user's passwd entry. yaac fixes that entry from the pod's
postStart hook, which may run after the entrypoint starts, so `sudo`, `ssh` or
`os.userInfo()` there can see the old one. See
[docs/arbitrary-uid-images.md](docs/arbitrary-uid-images.md).

## Nested containers

`"nestedContainers": true` (k8s only) runs a podman engine inside the
workspace pod and points the `docker` CLI and compose at it, so
`docker build`, `docker run` and `docker compose up --build` work as a
project's README says.

- Image pulls go through the egress proxy. docker.io, ghcr.io, quay.io and
  their CDNs are added to the allowlist; other registries are blocked unless
  you allow them. Build steps and containers trust the proxy's CA
  automatically.
- Containers share the pod's network: a container listening on a port is
  reachable at `localhost:<port>`, `docker run -p` does nothing, and
  container-private networks are not supported. Use `network_mode: host` in
  compose files.
- Built images are saved to a per-project registry when a workspace stops, so
  the same `docker build` in the next workspace is a cache hit. Only the
  project's own workspaces can reach that registry.

See [docs/nested-containers.md](docs/nested-containers.md).

To run yaac inside a workspace, no container support is needed: start the
inner server with `yaac server start`. That is the containerless driver, so its
workspaces are tmux servers in the outer workspace's checkout.
