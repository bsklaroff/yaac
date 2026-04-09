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

## Project configuration

Add a `yaac-config.json` to your repo root:

```json
{
  "envPassthrough": ["TERM", "LANG"],
  "envSecretProxy": {
    "GITHUB_TOKEN": ["api.github.com", "github.com"],
    "ANTHROPIC_API_KEY": ["api.anthropic.com"]
  },
  "cacheVolumes": {
    "pnpm-store": "/root/.local/share/pnpm/store/v3"
  },
  "initCommands": ["pnpm install"]
}
```

- **envPassthrough** — environment variables passed directly from your host to the container.
- **envSecretProxy** — environment variables injected via a MITM proxy into HTTPS requests to the listed hosts. The actual secret value never enters the container.
- **cacheVolumes** — named Podman volumes mounted into the container. Keys are volume names, values are absolute container paths. Volumes persist across sessions and are also available during `yaac-setup.sh`.
- **initCommands** — commands run inside the container after it starts (e.g. `pnpm install` against a warm cache volume). These run on every session, not just the first.

## Custom images

The default image (Ubuntu 24.04 + Claude Code + gh + tmux) can be customized:

- **`~/.yaac/Dockerfile.yaac`** — replaces the default image entirely (e.g. use a different base distro or toolchain). Must install Claude Code, since the default Dockerfile is not used.
- **`yaac-setup.sh`** in the project repo root — runs inside `/workspace` for project-specific setup (e.g. install project dependencies). The post-setup container is cached as a podman image; if neither the base image nor the script changes, the cached image is reused. Changes to files in `/workspace` are not cached — only changes to the rest of the container filesystem (installed packages, global configs, etc.) are persisted in the image layer.
- **`~/.yaac/Dockerfile.user`** — applied on top of whichever base is used (e.g. nvim config, shell customization).

Layer order: default (or Dockerfile.yaac) → yaac-setup.sh → Dockerfile.user.

## Local overrides

You can override `yaac-config.json` and `yaac-setup.sh` per-machine without modifying the repo. Place override files in the project's config-override directory:

```
~/.yaac/projects/<slug>/config-override/yaac-config.json
~/.yaac/projects/<slug>/config-override/yaac-setup.sh
```

If an override file exists, it fully replaces the corresponding file from the repo (no merging). This is useful for machine-specific setup or testing changes to the config without committing them.

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
  list [project]              List active sessions
  shell <container-id>        Open a bash shell in a session container
  attach <container-id>       Attach to the Claude Code session
```

Detach from a tmux session with `Ctrl-B D`.
