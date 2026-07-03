# Cluster setup

Current-state reference for `yaac cluster setup` — the runtime yaac needs,
what the command provisions, and why. Companion to `yaac cluster check`,
which verifies all of it (the command finishes by running it).

```sh
yaac cluster setup
```

The command bootstraps the podman machine on macOS (see below), starts the
local registry, creates a kind cluster from the bundled
`k8s/kind-config.yaml`, installs pinned Cilium (`envoyConfig.enabled=true` —
the session-egress redirect needs it), and applies the node fixups.

## The split runtime

yaac splits the container runtime in two:

- **Podman** builds session images (`podman build` / `podman push`) and
  hosts the kind node container.
- **Kubernetes** runs the sessions — one Job (single-pod) per session, plus
  a shared proxy Deployment. yaac targets a **local single-node cluster**
  (kind recommended). Session pods run with `hostUsers: false` (user
  namespaces), so the filesystem backing your home directory must support
  idmapped mounts — ext4/xfs/btrfs on Linux, libkrun's virtiofs on macOS
  (see below).

## macOS: the podman machine

On macOS, podman runs inside a VM, and yaac needs two non-default machine
settings — **rootful** (kind requires it) and the **libkrun provider**
(session pods run in user namespaces, which need idmapped-mount support on
the VM's file sharing — libkrun's virtiofs has it, Apple's
Virtualization.framework does not). `yaac cluster setup` applies both: it
writes a `containers.conf.d` drop-in selecting libkrun and drives
`podman machine init --rootful` + start. Use podman >= 6.0 with krunkit
>= 1.2.0: podman 6 passes krunkit's `--timesync` flag itself
([podman#28527](https://github.com/containers/podman/pull/28527)) and its
machine image ships the vsock guest agent
([podman-machine-os#238](https://github.com/containers/podman-machine-os/pull/238)),
so the VM clock survives Mac sleep
([podman#11541](https://github.com/containers/podman/issues/11541)) with no
manual wiring.

> **Upgrading from a pre-6.0 install:** a machine provisioned under podman
> 5.x lacks the 6.0 image's guest wiring and must be recreated
> (`podman machine rm` + re-init) — `yaac cluster setup` detects this and
> prompts. If you added the old README's manual krunkit `--timesync`
> wrapper, remove it
> (`mv /opt/homebrew/bin/krunkit-real /opt/homebrew/bin/krunkit`); the
> duplicated flag breaks machine start under podman 6, and
> `yaac cluster setup` refuses to proceed until it's gone.

## Version skew: podman 6.x needs a patched kind

**Don't bump podman alone.** Podman 6.0 changed the container label format
from a map to a slice, which breaks how kind <= v0.32.0 enumerates its node
containers (`kind get clusters` fails with `exit status 125` —
[kind#4201](https://github.com/kubernetes-sigs/kind/issues/4201)). The fix
([kind#4203](https://github.com/kubernetes-sigs/kind/pull/4203)) is merged
to `main` but unreleased (latest stable is v0.32.0; even v0.33.0-alpha
predates it). The brew formula handles this by depending on `yaac-kind`, a
build pinned past the fix. Installing by hand: stay on podman 5.x, or build
kind from `main` (`go install sigs.k8s.io/kind@main` — note `@latest`
resolves to the v0.32.0 tag, which lacks the fix). `yaac cluster setup`
preflights the pair and reports the skew explicitly. yaac's own podman
calls are unaffected (they read `.ID`/`.Repository`/`.Tag`, not `.Labels`);
only kind's provider breaks.

## What it wires up

1. **Local image registry** on `127.0.0.1:5001` — yaac pushes built session
   images there and pods pull them as `localhost:5001/...` (the kind
   [local-registry pattern](https://kind.sigs.k8s.io/docs/user/local-registry/)).
   Host port 5001 (not the registry-default 5000) sidesteps macOS AirPlay
   Receiver, which binds `::1:5000`; the container-internal port stays 5000.
2. **Home-directory extraMount** — session pods mount worktrees, caches, and
   credentials via `hostPath`, which resolves on the *node*. Mounting
   `$HOME` into the node at the same path makes node == host for everything
   yaac touches.
3. **Unmasked sysfs mount on the node** — session pods run in user
   namespaces (`hostUsers: false`), and the kernel refuses to start them
   while kind's `/sys` masks make sysfs "not fully visible"
   ([kind#3436](https://github.com/kubernetes-sigs/kind/issues/3436)).
4. **Node limits** — `DefaultTasksMax=infinity` + VM memory sysctls inside
   the node and a raised pids-limit on the node container, so subagent
   fan-out and virtiofs I/O don't die with
   `fork: resource temporarily unavailable`.

## Node fixups vanish on restart

The sysfs mount and the node limits live in node/VM state and **vanish on a
node or VM restart** (e.g. after restarting the podman machine). Re-apply
them without recreating the cluster:

```sh
yaac cluster setup --repair
```

`yaac cluster check` detects when they're missing and points here.

## User namespaces and uids

User namespaces are what keep in-container root unprivileged: the session
image grants passwordless sudo (agents can `apt-get install` mid-session),
and the userns maps uid 0 in the pod to a throwaway unprivileged uid on the
node — the same containment rootless podman gave the pre-kubernetes backend.

The idmapped mounts that come with user namespaces present hostPath files at
their real node-side uids, so the session image builds its `yaac` user with
the daemon's uid (`YAAC_UID` build arg, baked in automatically and folded
into the image tag). Nothing to configure — but if your uid ever changes,
images rebuild on their own, and a standalone `Dockerfile.yaac` that creates
its own user should honor `ARG YAAC_UID` the same way
`dockerfiles/Dockerfile.default` does, or its writes to `/workspace` will
fail with `Permission denied`.

## Verifying

`yaac cluster check` verifies kubectl, the cluster, the registry, the
namespace, and the node fixups, then runs an end-to-end probe pod —
user-namespaced, like session pods — that exercises all of the wiring above,
including a hostPath **write** at the session uid. Run it whenever sessions
fail to start.

> **v1 limits:** single-node clusters only (the hostPath model assumes
> node == host). The daemon's control traffic reaches the proxy through a
> loopback `kubectl port-forward`; nothing yaac deploys listens on host
> interfaces.
