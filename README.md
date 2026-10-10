# Yet Another Agent Container

yaac runs many agent sessions in parallel, each in its own workspace: a git
clone of your project with one or more agents working in it. It supports
Claude Code, Codex CLI, OpenCode, and Pi.

A workspace runs on one of two drivers, decided by how you start the server:

- **kubernetes** (`yaac cluster install`): each workspace is a
  gVisor-sandboxed pod built from an image, reaching the network only through
  an egress proxy that holds your real credentials. One command installs it
  wherever you want it to run: a kind cluster on a single Linux or macOS
  machine, a self-managed multi-node cluster (on a few Hetzner boxes, say), or
  a managed cloud such as AWS EKS
  ([docs/cluster-setup.md](docs/cluster-setup.md#bring-your-own-cluster)).
- **containerless** (`yaac server start`): agents run directly on your machine,
  each workspace in its own git checkout, like other multi-agent managers.
  No cluster, image, or sandbox: they run as you, with direct access to your
  credentials ([docs/containerless-driver.md](docs/containerless-driver.md)).

One machine can run both: each keeps its own data dir (`~/.yaac` for the
host server, `~/.yaac-cluster` for a cluster) and both show up as servers
you can switch between.

## Install

### Homebrew (macOS, arm64)

```sh
brew trust bsklaroff/yaac
brew install bsklaroff/yaac/yaac-server
yaac server start && yaac host check   # containerless
```

For the kubernetes driver, add the local cluster's tools, including a
patched `krunkit`/`libkrun` pair
([why](docs/cluster-setup.md#macos-the-podman-machine)):

```sh
brew trust libkrun/krun
brew tap libkrun/krun
brew install bsklaroff/yaac/yaac-cluster
yaac cluster install
```

To install from source on macOS or Linux, see
[docs/install-from-source.md](docs/install-from-source.md).

## Getting started

Build and install the macOS desktop app, then open yaac from /Applications:

```sh
# Skip these two lines if you installed from source
brew install pnpm
git clone https://github.com/bsklaroff/yaac.git && cd yaac

pnpm install && pnpm desktop:install
```

The app connects to the server you started above, lives in the tray (closing
the window hides it), and forwards workspace ports to this machine
([packages/desktop/README.md](packages/desktop/README.md)). In the app:

1. **Settings → Credentials → Agent tools:** sign in to Claude Code, Codex,
   OpenCode, or Pi.
2. **Settings → Credentials → Git credentials:** add an HTTPS token, or have
   yaac generate an SSH key and add its public half to your git host.
3. **Settings → General → Git identity:** the name and email workspaces
   commit as.
4. **New project:** paste the repository URL and pick its git credential.
5. **New workspace:** pick a tool, write a prompt, and start it.

To use the server from other devices over Tailscale, see
[docs/remote-hosting.md](docs/remote-hosting.md); to share it with
teammates, each as their own user, see
[docs/multi-user.md](docs/multi-user.md).

## Credentials

Sign-ins and git credentials are stored on the server. Under kubernetes, real
tokens never enter a workspace: it gets placeholders, and the egress proxy
swaps in the real values on outgoing requests. Under containerless, workspaces
get the real credentials. See
[docs/git-credentials.md](docs/git-credentials.md).

## Reference

- [Project configuration](docs/project-config.md): initialization commands,
  port forwarding, cache volumes, the egress allowlist, nested containers,
  environment variables and secrets, and custom images
- [CLI](docs/cli.md): every `yaac` command and option
- [Environment variables](docs/environment-variables.md): server settings

## License

yaac is released under the [MIT License](LICENSE.md).
