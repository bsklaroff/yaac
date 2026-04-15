# Yet Another Agent Container

Agent sandbox manager — run Claude Code sessions in isolated Podman containers.

## Install

Clone the repo and install globally:

```sh
git clone https://github.com/bsklaroff/yaac.git
cd yaac
pnpm install
pnpm build
npm install -g .
```

Install [Podman](https://podman.io/) (version 5.0+) for containerization:

```sh
# macOS
brew install podman
sudo /opt/homebrew/Cellar/podman/$(podman --version | cut -d' ' -f3)/bin/podman-mac-helper install
podman machine init
podman machine start

# Debian / Ubuntu (25.04+)
sudo apt install podman

# Ubuntu 24.04 — pin podman from 25.04 (plucky):
echo 'deb http://archive.ubuntu.com/ubuntu plucky main universe' | sudo tee /etc/apt/sources.list.d/plucky.list
printf 'Package: *\nPin: release n=plucky\nPin-Priority: 100\n' | sudo tee /etc/apt/preferences.d/plucky
sudo apt update && sudo apt install -t plucky podman crun
```

## Usage

```
yaac [command]

Commands:
  project         Manage projects
  session         Manage sessions
  auth            Manage GitHub credentials

yaac project <command>
  list              List all projects
  add <remote-url>  Add a project (GitHub HTTPS URL or owner/repo)

yaac session <command>
  create [options] <project>  Create a new session for a project
    -p, --prompt <prompt>     Initial prompt to pass to Claude Code
    --add-dir <path>          Mount a host directory read-only (repeatable)
    --add-dir-rw <path>       Mount a host directory read-write (repeatable)
  list [options] [project]    List active sessions
    -d, --deleted             List deleted sessions from Claude Code history
  delete <session-id>         Delete a session and clean up its resources
  attach <container-id>       Attach to the Claude Code tmux session
  stream [project]            Stream through waiting sessions, attaching to
                              each in turn
  monitor [options] [project] Poll and display active sessions in real-time
    -n, --interval <seconds>  Refresh interval in seconds (default: 5)

yaac auth <command>
  list                List configured GitHub tokens (masked)
  update              Add or replace a GitHub Personal Access Token (interactive)
  clear               Remove stored GitHub credentials (interactive)
```

Detach from a tmux session with `Ctrl-B D`. Kill the tmux session (and the
container) with `Ctrl-B K` (custom binding, not standard tmux). Open a new
shell in the tmux session with `Ctrl-B C`, and switch between shells with `Ctrl-B N` (next) and
`Ctrl-B P` (previous).

## Authentication

yaac requires one or more GitHub Personal Access Tokens (PATs) for git operations and GitHub API access inside session containers. Multiple tokens can be scoped to different owners so you can use separate tokens for different orgs or personal repos.

Tokens are stored in `~/.yaac/.credentials.json` (file permissions `0600`) as an ordered list. When yaac needs a token for a given repo, it walks the list and uses the first matching entry:

```json
{
  "tokens": [
    { "pattern": "acme-corp/*", "token": "ghp_org_scoped_token" },
    { "pattern": "my-user/private-repo", "token": "ghp_repo_scoped_token" },
    { "pattern": "*", "token": "ghp_fallback_token" }
  ]
}
```

Each pattern takes one of three forms:
- `*` — catch-all default, matches any repo
- `<owner>/*` — matches all repos under an owner (org or personal account)
- `<owner>/<repo>` — matches a specific repo

First match wins, so put more specific patterns before broader ones. On first run, yaac prompts for a token if none are configured.

Tokens are used for:
- **Host-side git operations** — clone and fetch use HTTPS with the matching token embedded in the request.
- **Container-side GitHub requests** — a MITM proxy sidecar injects the token as an `Authorization` header into all HTTPS requests to `github.com` and `api.github.com`. The token is never written into the container filesystem. Each session uses the single token that matches its project's remote URL.

Token injection only happens over HTTPS. Plain HTTP requests through the proxy never receive credentials.

## Container layout

Each session runs in an isolated container with the following mounts:

| Host | Container | Description |
|------|-----------|-------------|
| `~/.yaac/projects/<project>/worktrees/<session-id>` | `/workspace` | Project code (working directory) |
| `~/.yaac/projects/<project>/repo/.git` | `/repo/.git` | Repository metadata |
| `~/.yaac/projects/<project>/claude/` | `/home/yaac/.claude` | Claude Code configuration |
| `~/.yaac/projects/<project>/claude.json` | `/home/yaac/.claude.json` | Claude Code project settings |

The container runs as user `yaac` with home directory `/home/yaac`. All project data is stored under `~/.yaac/projects/<repo-name>/`. The repo, Claude config, and Claude project settings are shared across all sessions within a project (but isolated between projects). Each session gets its own git worktree.

## Project configuration

Add a `yaac-config.json` to your repo root. Example with all options:

```json
{
  "envPassthrough": ["TERM", "LANG"],
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
    "pnpm-store": "/home/yaac/.pnpm-store"
  },
  "initCommands": ["pnpm install --store-dir /home/yaac/.pnpm-store"],
  "addAllowedUrls": ["internal.corp.example.com", "*.mycdn.example.com"],
  "nestedContainers": false,
  "hideInitPane": false,
  "pgRelay": {
    "enabled": true,
    "hostPort": 5432,
    "containerPort": 5432
  }
}
```

- **envPassthrough** — environment variables passed directly from your host to the container.
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
- **cacheVolumes** — named Podman volumes mounted into the container. Keys are volume names, values are absolute container paths. Volumes persist across sessions.
- **initCommands** — commands run inside the container after it starts (e.g. `pnpm install` against a warm cache volume). These run on every session, not just the first.
- **nestedContainers** — when `true`, enables podman-in-podman support so sessions can build and run containers (default: `false`). See [Nested containers](#nested-containers) below.
- **hideInitPane** — when `true`, the init commands tmux pane is automatically closed after the commands finish or error (default: `false`). When `false`, the pane is preserved with `remain-on-exit` so you can inspect the output.
- **pgRelay** — configures a PostgreSQL relay sidecar that forwards connections from inside the container to a PostgreSQL instance on the host. The relay uses `socat` to proxy TCP traffic so that `localhost` connections inside the session reach your host database.
  - **`enabled`** — must be set to `true` to start the relay (default: `false`). The relay will not run unless this is explicitly enabled.
  - **`hostPort`** — port PostgreSQL listens on the host (default: `5432`).
  - **`containerPort`** — port exposed inside the container for the relay (default: `5432`).
- **addAllowedUrls** — additional host patterns to allow on top of the [default allowlist](src/lib/container/default-allowed-hosts.ts). By default, the proxy blocks outbound requests to hosts not on the default list. Use this to add extra hosts without replacing the defaults. Supports exact hostnames (`api.example.com`) and wildcards (`*.example.com`).
- **setAllowedUrls** — completely replaces the default allowlist with the given list of host patterns. Cannot be used together with `addAllowedUrls`. Set to `["*"]` to allow all outbound URLs (disables filtering), or `[]` to block all external network access. If the resolved list does not include `api.anthropic.com` or `github.com`, a warning is printed since sessions require these to function.

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

  Place in the repo root or the project's config-override directory (config-override takes precedence).
- **`~/.yaac/Dockerfile.user`** — applied on top of whichever base is used (e.g. nvim config, shell customization). Must use `ARG BASE_IMAGE` and `FROM ${BASE_IMAGE}` so the parent image is injected via `--build-arg`:
  ```dockerfile
  ARG BASE_IMAGE
  FROM ${BASE_IMAGE}
  # Rest of Dockerfile...
  ```

Layer order: default (or Dockerfile.yaac) → Dockerfile.nestable (if `nestedContainers` is true) → Dockerfile.user.

## Local overrides

You can override project files per-machine without modifying the repo. Place override files in the project's config-override directory:

```
~/.yaac/projects/<repo-name>/config-override/yaac-config.json
~/.yaac/projects/<repo-name>/config-override/Dockerfile.yaac
```

If an override file exists, it fully replaces the corresponding file from the repo (no merging). This is useful for machine-specific setup or testing changes to the config without committing them.

## Nested containers

Set `"nestedContainers": true` in `yaac-config.json` to let sessions run `podman` (podman-in-podman). This builds an extra image layer (`Dockerfile.nestable`) on top of whichever base is used (default or custom `Dockerfile.yaac`) that configures rootless podman inside the container.

No `--privileged` flag or extra capabilities are needed. At runtime, yaac adds the following security overrides:

- `--security-opt label=disable` — disables SELinux label confinement
- `--security-opt unmask=/proc/sys` — unmasks `/proc/sys` inside the container
- `--device /dev/net/tun` — exposes the TUN device for container networking
- A per-project named volume is mounted for container storage so pulled images persist across sessions.

On macOS, the default podman machine memory (2 GB) is not enough for nested container builds. Increase it to at least 4 GB (8 GB recommended):

```sh
podman machine stop
podman machine set --memory 8192
podman machine start
```
