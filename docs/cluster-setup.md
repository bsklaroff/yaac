# Cluster setup

Current-state reference for `yaac cluster setup` — the runtime yaac needs,
what the command provisions, and why. Companion to `yaac cluster check`,
which verifies all of it (the command finishes by running it).

```sh
yaac cluster setup
```

The command bootstraps the podman machine on macOS (see below) — or expects a
reachable rootful podman on Linux (see below) — starts the local registry,
creates a kind cluster from the bundled `k8s/kind-config.yaml`, installs pinned
Cilium (`envoyConfig.enabled=true` — the session-egress redirect needs it), and
applies the node fixups.

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
`podman machine init --rootful` + start. Use podman >= 6.0 with the tap's
`yaac-krunkit` — a stock brew krunkit (<= 1.3.x) never selects the virtiofs
permission semantics under which libkrun advertises idmapped-mount support,
so session pods fail with `MOUNT_ATTR_IDMAP` EINVAL
([#27](https://github.com/bsklaroff/yaac/issues/27); `yaac-krunkit` is
upstream krunkit built against a patched `yaac-libkrun`). podman 6 passes
krunkit's `--timesync` flag itself
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

## Linux: rootful podman

On Linux, yaac drives the **rootful** podman engine — the same choice as the
macOS machine, for the same reason. kind's node runs as a container on this
engine, and the cilium agent needs privileges that only exist in the initial
user namespace. Under rootless podman the node lives in a user namespace,
where the kernel denies the agent's `mount-bpf-fs` init container
(`mount: /sys/fs/bpf: permission denied`), so the agent pod crash-loops in
init and never leaves phase Pending: `yaac cluster setup` hangs at
`1 pods of DaemonSet cilium are not ready / pod is pending` and times out.
Even on kernels new enough to permit that mount in a user namespace (>= 6.9),
loading the datapath's BPF programs still needs CAP_BPF in the initial user
namespace — rootful is required either way.

yaac points both halves of the split runtime at the rootful engine by setting
`CONTAINER_HOST=unix:///run/podman/podman.sock` at startup
(`ensureRootfulPodmanHost` in `src/lib/container/runtime.ts`): kind inherits it
(so its podman provider uses rootful) and every `podman build`/`push` call
targets the same store the cluster pulls from. A `CONTAINER_HOST` you set
yourself is left untouched.

The rootful socket is root-owned and systemd-activated, so yaac (unprivileged)
can't start it — enable it once and grant your user access:

```sh
sudo apt install podman              # Debian/Ubuntu (or dnf on Fedora/RHEL)
sudo systemctl enable --now podman.socket
sudo setfacl -m u:$USER:x /run/podman
sudo setfacl -m u:$USER:rw /run/podman/podman.sock
```

For access that survives socket recreation, use a `podman.socket` systemd
drop-in (`sudo systemctl edit podman.socket`) setting `SocketMode=0660` and
`SocketGroup=` to a group you belong to. `yaac cluster setup` prints these same
steps if the rootful socket isn't reachable.

> **Nested (in-pod) sessions are exempt:** inside a yaac session
> (`YAAC_NESTED=1`) the in-pod podman is rootless on its own per-uid socket, so
> the rootful default does not apply there.

## Linux: VPN and firewall interference

Two host-level blockers that both present as "container is up but its
published port doesn't answer" (the registry probe on `127.0.0.1:5001`,
kind's API server on `127.0.0.1:<port>`):

- **VPN firewalls (e.g. Mullvad)** reject traffic to the podman bridge
  subnets — including loopback-published ports, whose destination is
  DNAT-rewritten to the container IP before the VPN's filter runs. The
  signature: `curl` fails instantly ("after 0 ms") while `tcpdump -i podman0`
  captures nothing. Enable the VPN's LAN exemption (Mullvad:
  `mullvad lan set allow`). Split tunneling does not help — the blocked
  traffic is kernel-forwarded, not owned by any process.
- **ufw hosts: pin netavark's iptables firewall driver.** The nftables
  driver keeps its rules in a separate table that ufw's default-deny can
  override, and it has been seen not intercepting loopback-published ports
  at all (connections land on podman's port-reservation socket and hang):

  ```sh
  printf '[network]\nfirewall_driver = "iptables"\n' \
    | sudo tee /etc/containers/containers.conf.d/50-firewall-driver.conf
  ```

  Switch drivers only with a reboot (or a full teardown of containers and
  networks) — `podman network reload` across a driver change leaves
  half-migrated rules behind.

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
3. **Node limits** — `DefaultTasksMax=infinity` + VM memory sysctls inside
   the node and a raised pids-limit on the node container, so subagent
   fan-out and virtiofs I/O don't die with
   `fork: resource temporarily unavailable`.
4. **The gVisor runtime** — a pinned `runsc` +
   `containerd-shim-runsc-v1` copied into every node, two runsc handlers
   registered in the node containerd config (`runsc` and `runsc-nested`,
   each with its own `/etc/containerd/runsc*.toml` flag file — both set
   `allow-suid` so the image's passwordless `sudo` works inside the sentry,
   `runsc-nested` additionally allows raw/packet sockets for the in-pod
   engine), and the `gvisor` and `gvisor-nested` RuntimeClasses applied to
   the cluster. Every pod hosting untrusted code carries one explicitly:
   plain sessions run on `gvisor`, nested-containers sessions run the
   rootful in-pod engine on `gvisor-nested`, and vcluster-synced tenant
   pods are stamped `gvisor` by the syncer. Trusted yaac infra (the proxy,
   registries, node-write pods, vcluster control planes) runs on runc — a
   sentry per infra pod starves the node for no containment gain.

## Node fixups vanish on restart

The node limits live in node/VM state and **vanish on a node or VM restart**
(e.g. after restarting the podman machine). Re-apply them without recreating
the cluster:

```sh
yaac cluster setup --repair
```

`yaac cluster check` detects when they're missing and points here.

## Runtimes and uids

Session containment is the **gVisor sentry**: every pod running untrusted
code (sessions, vcluster-synced tenant pods, the check's probe pods) runs
under the `gvisor` RuntimeClass, where in-container root — the image grants
passwordless sudo so agents can `apt-get install` mid-session — is a sandbox
fiction with no host authority, and no user namespace is used.
Nested-containers sessions run their in-pod container engine as **real root
inside the sentry** on the `gvisor-nested` RuntimeClass (the sentry is the
containment). Trusted yaac infra (proxy, registries, node-write pods,
vcluster control planes) runs unsandboxed on runc: it only executes
yaac-shipped code, and the sentries' CPU cost is what matters at fleet
scale.

Under gVisor there is no user namespace and no idmap, so hostPath files are
presented at their real node-side uids (the gofer preserves them), and the
session image builds its `yaac` user with the server's uid
(`YAAC_UID` build arg, baked in automatically and folded into the image
tag). Nothing to configure — but if your uid ever changes, images rebuild
on their own, and a standalone `Dockerfile.yaac` that creates its own user
should honor `ARG YAAC_UID` the same way `dockerfiles/Dockerfile.default`
does, or its writes to `/workspace` will fail with `Permission denied`.

## Verifying

`yaac cluster check` verifies kubectl, the cluster, the registry, the
namespace, and the node fixups, asserts the RuntimeClasses exist and that a
`gvisor`-class pod really runs inside the sentry, then runs an end-to-end
probe pod — on the gvisor tier, like session pods — that exercises all of
the wiring above, including a hostPath **write** at the session uid. It
ends with a sweep warning about any untrusted pod (session-labeled or
vcluster-synced) running without a gvisor-tier `runtimeClassName` (pods
predating the gVisor migration). Run it whenever sessions fail to start.

> **v1 limits:** single-node clusters only (the hostPath model assumes
> node == host). The server's control traffic reaches the proxy through a
> loopback exec tunnel (`kubectl exec` + socat — runtime-agnostic, unlike
> `kubectl port-forward`, which cannot reach gVisor pods); nothing yaac
> deploys listens on host interfaces.

## Deleting the cluster

```sh
yaac cluster delete        # prompts first; -y / --yes skips the prompt
```

The teardown counterpart to `setup`. It deletes the kind cluster (which
takes the node and everything living in it — Cilium, every vcluster, the
per-project registries, and all node-local storage) and removes the local
`yaac-registry` container that sits beside it on podman. Running session pods
stop, but nothing under the yaac data dir is touched: on-disk sessions and
worktrees survive, and a later `yaac cluster setup` recreates the cluster and
re-pushes images on demand. It leaves the podman machine and its shared image
store alone (that's the build engine, not the cluster), and refuses to run
inside a nested yaac session — there the cluster belongs to the outer
install.
