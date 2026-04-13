# Yet Another Agent Container

Agent sandbox manager — run Claude Code sessions in isolated Podman containers.

## Prerequisites

- [Node.js](https://nodejs.org/) v22+
- [pnpm](https://pnpm.io/) v10+
- [Podman](https://podman.io/) v4+

### macOS

```sh
brew install podman
sudo /opt/homebrew/Cellar/podman/$(podman --version | cut -d' ' -f3)/bin/podman-mac-helper install
podman machine init
podman machine start
```

### Linux

```sh
sudo apt install podman    # Debian/Ubuntu
sudo dnf install podman    # Fedora/RHEL
```

## Install

Clone the repo and install globally:

```sh
git clone https://github.com/bsklaroff/yaac.git
cd yaac
pnpm install
pnpm build
npm install -g .
```

## Usage

```
yaac [command]

Commands:
  project         Manage projects
  session         Manage sessions

yaac project <command>
  list              List all projects
  add <remote-url>  Add a project from a git remote

yaac session <command>
  create [options] <project>  Create a new session for a project
    -p, --prompt <prompt>     Initial prompt to pass to Claude Code
  list [options] [project]    List active sessions
    -d, --deleted             List deleted sessions from Claude Code history
  delete <session-id>         Delete a session and clean up its resources
  shell <container-id>        Open a bash shell in a session container
  attach <container-id>       Attach to the Claude Code session
  stream [project]            Stream through waiting sessions, attaching to
                              each in turn
  monitor [options] [project] Poll and display active sessions in real-time
    -n, --interval <seconds>  Refresh interval in seconds (default: 5)
```

Detach from a tmux session with `Ctrl-B D`. Kill the tmux server (and the
container) with `Ctrl-B K`.

## Project configuration

Add a `yaac-config.json` to your repo root:

```json
{
  "envPassthrough": ["TERM", "LANG"],
  "envSecretProxy": {
    "GITHUB_TOKEN": {
      "hosts": ["api.github.com", "github.com"]
    },
    "ANTHROPIC_API_KEY": {
      "hosts": ["api.anthropic.com"],
      "header": "x-api-key"
    }
  },
  "cacheVolumes": {
    "pnpm-store": "/home/yaac/.pnpm-store"
  },
  "initCommands": ["pnpm install --store-dir /home/yaac/.pnpm-store"]
}
```

- **envPassthrough** — environment variables passed directly from your host to the container.
- **envSecretProxy** — environment variables injected via a MITM proxy into HTTPS requests. The actual secret value never enters the container. Each entry specifies how the secret is injected:
  - **`hosts`** — hostnames to intercept (required).
  - **`header`** — inject as this HTTP header (default: `"authorization"`). When using the default header, the value is automatically prefixed with `"Bearer "`. Use `prefix` to override.
  - **`bodyParam`** — instead of a header, replace this form/JSON body parameter. Useful for OAuth client credentials that are sent in POST bodies.
  - **`path`** — only inject on matching URL paths (default `"/*"`). Supports `*` wildcards.

  Each entry must have either `header` or `bodyParam` (not both).

  **Example: OAuth client credentials** — for APIs that authenticate with a client ID and
  secret (e.g. GitHub OAuth Apps, Google APIs), use `bodyParam` to inject the real
  credentials into token exchange requests:

  ```json
  {
    "envSecretProxy": {
      "GITHUB_CLIENT_ID": {
        "hosts": ["github.com"],
        "path": "/login/oauth/*",
        "bodyParam": "client_id"
      },
      "GITHUB_CLIENT_SECRET": {
        "hosts": ["github.com"],
        "path": "/login/oauth/*",
        "bodyParam": "client_secret"
      }
    }
  }
  ```

  The container code performs the OAuth flow normally with placeholder values. The proxy
  intercepts the token exchange request and replaces the placeholder `client_id` and
  `client_secret` in the POST body with the real values from your host environment.
- **cacheVolumes** — named Podman volumes mounted into the container. Keys are volume names, values are absolute container paths. Volumes persist across sessions.
- **initCommands** — commands run inside the container after it starts (e.g. `pnpm install` against a warm cache volume). These run on every session, not just the first.
- **nestedContainers** — when `true`, enables podman-in-podman support so sessions can build and run containers. See [Nested containers](#nested-containers) below.

## Custom images

The default image (Ubuntu 24.04 + Node.js + pnpm + Claude Code + gh + tmux) can be customized:

- **`Dockerfile.yaac`** — replaces the default image entirely (e.g. use a different base distro or toolchain). Must install Claude Code, since the default Dockerfile is not used. Place in the repo root or the project's config-override directory (config-override takes precedence).
- **`~/.yaac/Dockerfile.user`** — applied on top of whichever base is used (e.g. nvim config, shell customization). Must start with `FROM yaac-current`.

Layer order: default (or Dockerfile.yaac) → Dockerfile.nestable (if `nestedContainers` is true) → Dockerfile.user.

## Local overrides

You can override project files per-machine without modifying the repo. Place override files in the project's config-override directory:

```
~/.yaac/projects/<slug>/config-override/yaac-config.json
~/.yaac/projects/<slug>/config-override/Dockerfile.yaac
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

