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
git clone https://github.com/anthropics/yaac.git
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
  }
}
```

- **envPassthrough** — environment variables passed directly from your host to the container.
- **envSecretProxy** — environment variables injected via a MITM proxy into HTTPS requests to the listed hosts. The actual secret value never enters the container.

## Custom images

The default image (Ubuntu 24.04 + Claude Code + gh + tmux) can be customized:

- **`~/.yaac/Dockerfile.yaac`** — replaces the default image entirely (e.g. use a different base distro or toolchain).
- **`yaac-setup.sh`** in the project repo root — runs on container start for project-specific setup (e.g. install project dependencies). The post-setup container is cached as a podman image; if neither the base image nor the script changes, the cached image is reused.
- **`~/.yaac/Dockerfile.user`** — applied on top of whichever base is used (e.g. nvim config, shell customization).

Layer order: default (or Dockerfile.yaac) → yaac-setup.sh → Dockerfile.user.

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
