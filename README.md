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

The base image (Ubuntu 24.04 + Claude Code + gh + tmux) can be extended:

- **`~/.yaac/Dockerfile.user`** — applied to all projects (e.g. nvim config).
- **`Dockerfile.yaac`** in the project repo — applied to that project only (e.g. install project dependencies).

Each layer builds on the previous: base → project → user.

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
