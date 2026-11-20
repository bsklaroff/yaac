# Yaac

Yaac is an open-source, self-hosted infrastructure platform which includes:

1. Agent sessions, automatically sandboxed and backed by git
2. Automated workflows, such as for CI/CD
3. Public site deployments, with persistent storage and custom URLs

It includes orchestration, logging, a transparent egress proxy, and
deployment gates for workflows and sites. Agents can develop code, set up
your infrastructure, or run automated maintenance, all while remaining blind
to your secrets.

It runs gVisor-backed containers on top of Kubernetes for security,
hardware flexibility, and scalability, either directly on your laptop (using kind) or on a remote
server or cluster (accessed via Tailscale). You can also run in containerless mode
directly on your machine, which skips sandboxing and secret management
entirely.

## Install

### Homebrew (macOS, arm64)

Install the desktop app:

```sh
brew install --cask bsklaroff/yaac/yaac-desktop
```

Install the CLI and start a containerless server:

```sh
brew install bsklaroff/yaac/yaac-server
yaac server start
```

Or install the CLI and a kubernetes cluster:

```sh
brew install bsklaroff/yaac/yaac-server bsklaroff/yaac/yaac-cluster
yaac cluster install
```

To install from source on macOS or Linux, see
[docs/install-from-source.md](docs/install-from-source.md).

## Reference

- [CLI](docs/cli.md): every `yaac` command and option
- [Project configuration](docs/project-config.md): init commands, ports,
  egress, secrets, and images
- [Git credentials](docs/git-credentials.md)
- [Workflows](docs/workflows.md) and [routines](docs/routines.md)
- [Public sites](docs/public-sites.md)
- [Cluster setup](docs/cluster-setup.md) and the
  [containerless driver](docs/containerless-driver.md)
- [Remote hosting](docs/remote-hosting.md) and
  [multi-user installs](docs/multi-user.md)
- [iPhone app](ios/README.md#set-up-your-iphone)

## License

yaac is released under the [MIT License](LICENSE.md).
