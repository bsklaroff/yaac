# Plan: a `sandbox` driver

A third workspace driver, beside `k8s` and `containerless`. It runs each
workspace as a sandboxed container on one host's container engine, with no
Kubernetes. Like `k8s`, a workspace gets an image, a sandbox and mediated
egress, so credentials stay sentinels and `bypass` stays the default
permission mode. Like `containerless`, the server is a host process, and
there is no cluster, Calico, netd, registry or kind to install.

Two sandboxes sit behind one driver, chosen by the host OS:

| Backend | Host | Boundary | Engine |
|---|---|---|---|
| `apple` | macOS 26, Apple silicon | a micro-VM per container | Apple `container` |
| `gvisor` | Linux | gVisor's user-space kernel, as k8s pods use | containerd + nerdctl, `io.containerd.runsc.v1` |

`k8s` stays for what only it provides: several nodes, shared network
storage, and installs into a cluster yaac did not create (`--byo`, the
`infra/` clusters). Kata is a later runtime for Linux hosts with KVM (see
"Later: Kata").

## Why containerd on Linux

- **runsc is a first-class runtime there.** `containerd-shim-runsc-v1` is
  the path GKE Sandbox and our own kind nodes use, so workspaces run the
  same gVisor integration pods do today. Podman runs runsc as a bare OCI
  runtime, which is less exercised.
- **Namespaces.** `nerdctl --namespace yaac` keeps yaac's containers and
  images out of the user's `docker ps`, and away from a k8s install's
  rootful podman store on the same host.
- **Kata is a runtime switch later**, not a second engine. Podman cannot
  run Kata 2 and later, which ship only a containerd shim.
- **Builds are BuildKit on both backends.** Apple's `container build` is
  BuildKit, and so is `nerdctl build`, so one progress parser serves both.

The cost is install friction. containerd, nerdctl and BuildKit are not all
in distro repos, so install validates a pinned `nerdctl-full` bundle, or
the containerd a Docker host already runs plus pinned nerdctl and buildkitd.

## What a backend must provide

Each backend is one module, `apple.ts` or `containerd.ts`, and it is the
only place its CLI is invoked. Unit tests mock it.

| Need | apple | gvisor |
|---|---|---|
| No network | `--network none` (no NIC) | `--network none` (loopback only) |
| Host socket into the sandbox | a socket given as a `-v` source is relayed in | runsc `host-uds=open` on a bind-mounted socket |
| Sandbox socket out to the host | `--publish-socket` | runsc `host-uds=create` in a bind-mounted dir |
| Labels, list, inspect | `-l`, `ls --all --format json` | `--label`, `ps -a --format json` |
| Change notifications | none: a per-container `logs -f` edge plus a poll | `nerdctl events` |
| Exec as a chosen user | `exec -u` | `exec -u` |
| Bind a host dir | virtiofs, one share per mount, directories only | gofer, as in pods |
| Private fast storage | named ext4 volume, tmpfs | disk-backed sentry tmpfs via annotations |
| Resource limits | `--cpus`, `--memory` per VM | `--cpus`, `--memory` (cgroups) |
| Build trusted images | `container build` | `nerdctl build` |
| Image store | local | containerd namespace `yaac` |

### Apple `container`

These facts come from `apple/container` at 1.5.0, the latest release as of
this writing, and its source.

- Each container is a Virtualization.framework VM with its own kernel.
  `container` talks over XPC to a per-user launchd agent and needs no root.
- Containers outlive our server, but not `container system stop` or a
  reboot.
- Memory the guest frees is **not returned to the host**, so a VM only grows
  toward its `--memory` limit.
- `container build` uses one shared, long-lived builder VM with network
  access, so it is only for trusted layers.
- A named volume is a block device and must never be attached to two
  running VMs at once.
- 1.0 shipped in June 2026. The releases since have fixed security issues in
  the virtiofs and socket-relay code, so the driver pins a minimum version.

## Naming

The driver is named after the substrate, while the CLI group and data dir
are named after the install, as for the other two:

| CLI group | Data dir | Driver |
|---|---|---|
| `yaac server` | `~/.yaac-server` | `containerless` |
| `yaac cluster` | `~/.yaac-cluster` | `k8s` |
| `yaac engine` | `~/.yaac-engine` | `sandbox` |

So the kind `sandbox` appears as
`DriverKind = 'k8s' | 'containerless' | 'sandbox'`, as the folder
`packages/server/src/drivers/sandbox/`, and later as
`docs/sandbox-driver.md`. `install.json` records the backend beside the
kind (`backend: 'apple' | 'gvisor'`). `yaac engine start` starts this
install's server, not the engine itself, just as `yaac cluster start`
scales the server Deployment rather than starting kind.

## Egress

The proxy (`k8s/proxy`) is reused on both backends, as a detached host
process, `yaac-egress`. Both steer traffic into it the same way: **a
workspace has no network interface beyond loopback, and its only way out
is one unix socket the proxy opened for that workspace alone.** Sockets
cross the boundary on both backends, by Apple's relay or by runsc's host
socket support. That replaces three k8s parts:

- NetworkPolicy's deny-by-default, because nothing is routable.
- netd's redirect, because a small program inside forwards to the socket.
- Pod-IP identity, because the proxy knows the workspace from the listener a
  connection arrived on, which nothing inside can forge.

It fails closed by construction: no host firewall rules exist that could be
missing, and nothing on the host, yaac's server included, is reachable from
a workspace. It needs no root on macOS, and on Linux nothing beyond the
engine setup.

### netshim

A small Node program, mounted from the install rather than baked into the
image, so a standalone `Dockerfile.yaac` gets it too. Started as root by the
launch's first exec, it:

- puts the sinkhole addresses on loopback (or, if a sandbox's netstack
  refuses, uses loopback addresses it already has; a spike decides);
- answers DNS on loopback with the sinkhole for every name;
- listens on `:443`, `:80` and the SSH sentinel, and serves `SSH_AUTH_SOCK`;
- sends each connection to `/run/yaac/egress.sock` with a PP2 header naming
  the original destination, which selects the proxy's handler.

It is untrusted. Root inside can kill or replace it, but it can only ever
reach its own workspace's socket, where the proxy applies that workspace's
policy whatever header arrives.

### The proxy process

The proxy is the k8s proxy with two seams:

- **`ProxyFeed`** delivers credentials, secrets and registrations, and
  accepts refreshed tokens and observed state. The k8s feed is today's
  Secret and ConfigMap watch. The local feed is a control socket carrying
  the same `{ data }` maps.
- **`WorkspaceIdentity`** answers "whose connection is this". It is by
  source IP under k8s (the current pod watch). Here it is per listener: when
  the server registers a workspace, the proxy opens that workspace's
  `egress.sock`, and every connection on it belongs to that workspace. The
  PP2 header's destination picks the handler; its source is ignored.

`entrypoint.sh`'s ssh-agent and tor start move into `main.ts`, so the same
start works in a pod and on a host, and a host proxy uses the host's `tor`.
The proxy is detached and adopted by a restarting server, so a server
restart never drops an agent's in-flight request. It keeps credentials in
memory, and its CA key is a 0600 file that is never mounted. yaac-mama and
hosted git reach the server through the proxy's existing relay, to a mama
listener on a unix socket, which fills the contract's `mamaRelay`.

### Alternatives not taken

- **A network interface per workspace with host firewall rules** (veths and
  nftables on Linux, a host-only network and a pf anchor on macOS). It
  would reuse netd's rule code. But pf needs root on a Mac, where nothing
  yaac installs runs as root today. And either firewall's rules can go
  missing (a flush, the window after a reboot, a Docker or ufw rewrite),
  which a socket cannot. Kata will need the Linux half of this (see
  "Later: Kata").

## Streams and ports

streamd listens on a socket on both backends (a new streamd option,
`YAAC_STREAM_SOCKET`):

- **apple:** a guest socket published to the host with `--publish-socket`.
- **gvisor:** a socket streamd creates in the bind-mounted socket dir, which
  runsc's `host-uds=create` makes connectable from the host.

Above the dial, everything is the k8s streamd client, moved into
`src/drivers/shared`: exec, ctrl, pty, the `ports` stream and the `tcp`
stream behind `dialPort`. The server binds no host port, and forwards are
the client tunnel from docs/port-forward-tunnel.md.

Each workspace's sockets live in one dir, `<socket root>/<short id>/`,
under a short temp path, because `sun_path` is about 104 bytes on macOS (as
containerless found). On gvisor that dir is bind-mounted at `/run/yaac`. On
apple the two sockets are mounted and published one by one.

## Data-dir mounts

This is the part that differs most between backends.

### What a workspace mounts

`createWorkspace` declares every mount as a host path or an emptyDir
(`domain/workspaces/create.ts`). Under k8s, `resolveMountSource` turns each
into a PVC subpath or a node hostPath. Under this driver the three tiers
are plain host dirs under `~/.yaac-engine`, as under containerless, so
every hostPath stays the host path. Grouped by what matters for mounting:

| Mount | Container path | Properties |
|---|---|---|
| checkout | `/workspace` | rw; read and written by the server on the host too |
| main clone's `.git` | the server's own path | **read-only**; the checkout's alternates point at it |
| claude, codex, pi, opencode-config homes | `/home/yaac/…` | rw; **shared live by every workspace of the project** |
| per-workspace history (claude `projects/`, file-history, codex `sessions/`) | inside those homes | rw; **nested** over the shared homes |
| claude project memory | inside the nested `projects/` | rw; **nested two deep** |
| codex SQLite home, pi sessions | own paths | rw; **SQLite** |
| opencode working copy and checkpoint | own paths | rw; **SQLite** (node-local tier) |
| ACP logs | own path | rw |
| attachments | own path | **read-only** |
| cache volumes | project-chosen | rw; shared by the project's workspaces |
| builtin skills, `workspace-bin` scripts, known_hosts | under the homes and `/usr/local/bin` | read-only; **single files** among them |
| proxy CA public cert | `/etc/yaac/certs` | read-only |
| socket dir | `/run/yaac` | the egress and streamd sockets (see above) |
| tmux socket dir | emptyDir | private scratch |
| scratch dirs (`node_modules`, …) | **inside `/workspace`** | private, heavy small-file I/O, must not be on the shared filesystem |

### Rules every backend must keep

1. **Only the named dirs, never a tier root.** The global tier holds every
   project; mounting it would hand one workspace all of them. The
   server-local tier is never mounted, as under k8s.
2. **Read-only must hold against root in the guest.** Agents have
   passwordless sudo, so read-only enforced only by the guest's mount
   flags can be remounted away. It must be enforced where the host serves
   the files.
3. **The server must not follow links an agent plants.** It reads
   checkouts and agent history on the host, as the host user. Under k8s
   `sandbox-fs.ts` already answers `no-links` for an isolated driver, and
   the `isolated` trait keeps that for this one. Every server-side reader
   of a workspace-written path goes through it.
4. **No new capabilities for mounting.** A non-nested workspace gets no
   `CAP_SYS_ADMIN`, so the guest cannot rearrange its mounts. Everything
   is mounted by the engine at create.
5. **No host socket in a mounted dir except the workspace's own.** runsc's
   `host-uds` lets the sandbox connect to any socket it can see, so the
   data dir keeps every other socket (the server's mama listener, the
   proxy's control socket) under `server-local/` or the socket root, never
   in a mounted dir.
6. **Files written through a bind are the server user's on the host**, so
   the server can always read and delete them. On gvisor the container runs
   as the install uid with group 0, as pods do
   (docs/arbitrary-uid-images.md). On apple it holds whatever the guest
   uid, because Apple's virtiofs does all host I/O as the Mac user (see
   "Ownership on Apple's virtiofs").

### Per backend

**gvisor** (gofer, exactly as in pods):

- The mount list maps one to one onto the pod spec's volumes, including
  nested and single-file mounts, and read-only holds at the gofer.
- **Scratch dirs and tmux dir:** disk-backed sentry tmpfs through the same
  `dev.gvisor.spec.mount.*` annotations the pod spec sets, passed with
  `nerdctl --annotation`.
- `cachedCheckout` is true, as under k8s.

**apple** (one virtiofs share per mount):

- **Directories:** each is a `-v`. Nested targets work if mounted parent
  first; the order is kept by `resolveMountSource`.
- **Single files:** `--mount type=bind` refuses files. The launch stages a
  workspace's file mounts in one directory under `sessions/<id>/`, mounts
  it once read-only, and the image's entry point links each target into
  it. A link is enough because the stage is read-only. A VM is a full
  kernel, so this needs no added capability: PID 1 runs as root in the
  guest before dropping to the install uid.
- **Read-only:** must be enforced by Apple's host-side virtiofs server.
  This is a spike, because it decides whether the `.git` and attachments
  mounts are safe.
- **Scratch dirs:** one named ext4 volume per scratch dir, mounted over its
  path. A block volume is fast, private and counts against disk, not
  memory. It is never shared, so cache volumes stay binds.
- **tmux dir:** a small tmpfs.

**Ownership on Apple's virtiofs.** Virtualization.framework's virtiofs does
not report real ownership. Every file in a share appears to be owned by the
process looking at it ([lima#1513](https://github.com/lima-vm/lima/issues/1513)).
That is why the k8s path on macOS needs the patched `yaac-krunkit`
(docs/cluster-setup.md): there, gVisor's root gofer is the process looking,
so every file appears root-owned and the workspace uid cannot write. Here
the guest kernel accesses files on behalf of the agent, so files appear
owned by the agent and writes succeed. All host I/O is done as the Mac
user, and a `chown` is silently dropped.

This is not a security difference. Inside a workspace on any backend the
agent can become root with sudo, so uid separation inside the workspace
never protected anything. The boundary is which dirs are mounted (rule 1)
and read-only enforced on the host (rule 2). It is a difference in what
tools see:

- a tool that requires a file to be owned by its own uid always passes
  (git's `safe.directory`, ssh's config checks, postgres's data dir);
- a tool that expects a file to be owned by a different user, or that
  relies on `chown` taking effect, is wrong here and nowhere else;
- `ls -l` shows the caller as owner, so it is no use for debugging
  ownership.

### Shared tool homes across sandboxes

Every workspace of a project mounts the same claude, codex, pi and opencode
homes, and each sandbox has its own kernel. That is the situation k8s
already has with an RWX NFS claim shared by pods on different nodes: no
cross-kernel file locks, and short attribute caches. So there is no new
failure mode, provided the caching is no looser than NFS's. A spike
confirms that on Apple's virtiofs, which documents no cache settings.

### What changes in code

`resolveMountSource` gets a sandbox version: tier check, identity path,
then the per-backend realization above. It reads only `hostPath` and
`emptyDir`, which is all domain produces. The k8s Job's `node-dirs` init
container has no counterpart; the server creates node-local dirs on the
host, as containerless does.

## Phase 0: make a third kind possible

### Replace kind comparisons with traits

About 45 sites compare the kind directly, most as `!== 'containerless'`
meaning "sandboxed with mediated egress", so a third kind would silently
inherit k8s behavior. Add one table in `@yaac/shared`:

```ts
/** What a substrate provides. Callers branch on these, never on the kind. */
export interface DriverTraits {
  /** Workspaces run behind an isolation boundary, with images and mediated
   *  egress: sentinel credentials, allowlists, `bypass` by default. */
  isolated: boolean
  /** Keeps prewarmed spares for fast creates. */
  sparePool: boolean
  /** Can run a container engine inside a workspace. */
  nestedContainers: boolean
  /** The checkout reaches the workspace through a filesystem that caches
   *  attributes, so a server-side edit must be reopened inside. */
  cachedCheckout: boolean
}
export const DRIVER_TRAITS: Record<DriverKind, DriverTraits> = { … }
```

As a `Record<DriverKind, …>`, the table does not compile until a new kind
answers every trait. Then:

- Domain, runtime, api and frontend read traits:
  `defaultPermissionMode`, `serverNeedsForwarder`, `reconcile.ts`,
  `create.ts`'s twelve branches, `files.ts`, `sandbox-fs.ts`,
  `credential-sync.ts`, `driver-features.ts`, the mama-token route and the
  seven frontend components. The snapshot keeps sending `driver`, and the
  webapp looks up its traits.
- Install management (the CLI, `install-record.ts`, the desktop's
  `server-control.ts`, `assertHostServerAllowed`) switches exhaustively on
  the kind, ending in a `never` check.
- `contract.ts`'s header and the `DriverKind` comment are rewritten around
  traits, and the `pod-stopped` death cause becomes `unit-stopped`.

This phase changes no behavior. Land it first and on its own.

### Choose the driver from the install record

`resolveDriverKind` becomes:

- in the cluster: `k8s`;
- otherwise, if `install.json` records `sandbox`: `sandbox`;
- otherwise: `containerless`.

`server-run.ts`'s ternary becomes a switch.

## Phase 1: move what the container drivers share

A driver cannot import a sibling, so these move into `src/drivers/shared`
with no behavior change:

- the streamd client (framing, exec, ctrl, pty, `waitForStreamd`) over a
  `dial(): Promise<Duplex>`;
- port forwarding (the allocator, the `ports` watcher, `dialWorkspacePort`'s
  rule);
- the fixed in-workspace paths (`containerWorkspacePaths`);
- the image chain (`resolveImageChain`, the hash helpers, build rows), with
  a BuildKit progress parser beside podman's;
- the egress encoding (registrations, credential files, secret values, the
  CA trust env, `GIT_SSH_COMMAND`);
- the gVisor mount annotations.

The proxy gains its local feed and per-listener identity.

## Phase 2: the gvisor backend

gVisor comes first. It reuses the most (the sandbox, the mount annotations
and the nested-container workarounds), and it runs on ordinary Linux CI
machines. That proves the driver, the proxy's local feed, netshim and
socket egress before the apple backend exists.

- **Install.** `yaac engine install` validates a one-time root setup, which
  it prints as sudo steps when missing and never runs itself, as `yaac
  cluster install` does for the rootful podman socket today:
  - containerd, nerdctl and buildkitd at pinned versions, with the user
    granted the containerd socket;
  - the pinned runsc and its shim;
  - a containerd runtime handler, `yaac-runsc`, whose runsc config sets
    `host-uds=all` and the overlay settings pods use.

  It then builds the trusted layers with `nerdctl build`, writes
  `install.json`, starts the server and registers its origin. It refuses a
  data dir recorded as another kind.
- **The other commands.** `yaac engine start|stop|restart|logs|status|check|uninstall`
  manage that host server. `check` runs an end-to-end probe: create a
  workspace-shaped container, write through a bind as the install uid,
  fail to write a read-only bind as root, reach the proxy, fail to reach
  anything else (a host listener, a second workspace, a literal internet
  address), and reach streamd.
- **Observation.** One `nerdctl events` stream filtered to the install
  label, plus `ps -a` on resync. Death cause comes from the exit status and
  OOM events.
- **What phase 2 refuses.** Untrusted layers until phase 4, and
  `nestedContainers` until phase 5. Their routes answer `NOT_SUPPORTED`.

## Phase 3: the apple backend

`apple.ts`, with:

- `--network none`, the egress socket mounted in and streamd's published;
- virtiofs staging for single files;
- ext4 volumes for scratch dirs;
- a `logs -f` liveness edge, because Apple has no events.

`install` checks for macOS 26, Apple silicon, the pinned `container`
version and its system service, and needs no sudo. Memory the guest frees
is not returned to macOS, so this backend's default memory limit may need
to be lower than gvisor's, and the new-workspace pane says so.

## Phase 4: untrusted layers

The trust split (docs/trust-split-builds.md) still holds. Each untrusted
`ensureImage` runs a throwaway **builder sandbox** on the install's own
backend:

- Its image is the digest-pinned `quay.io/podman/stable` that k8s builder
  pods use, with netshim mounted as for workspaces.
- Its egress goes through a builder registration that allows `*` but
  injects nothing, so it never reaches the host's services.
- Its graphroot is a per-project cache volume. `build-coordinator`
  deduplicates only by tag and podman's locks do not cross sandboxes, so
  the driver queues untrusted builds per project.
- The result is `podman save`d and loaded into the engine's store.
- Under gvisor the builder uses the k8s builder pod's argv unchanged:
  chroot isolation and a tmpfs graphroot. Under apple it builds plainly.

Prewarm reuses `reconcileImagePrewarm`. GC keeps the live set plus the
newest two generations per repo (docs/image-gc.md), deletes cache volumes
of deleted projects and prunes. There is no registry, promoter or node
store.

## Phase 5: nested containers

Rootful podman inside the workspace:

- **gvisor:** the `gvisor-nested` settings as they are: a second runtime
  handler with raw sockets, `NESTED_ENGINE_CAPS`, a sentry tmpfs graphroot.
- **apple:** a real kernel, so the capabilities alone, and a plainer
  `Dockerfile.nestable`.

Salvage saves a workspace's built images into its project's build cache
before teardown.

## Spare pool

Off at first (`sparePool: false`). If boot to ready measures above about
five seconds on a backend, the existing pool policy can be enabled for it
with a label-based claim.

## Later: Kata

Kata (a micro-VM per container on Linux hosts with KVM) would be a second
runtime handler on the same containerd module. Its blocker is egress: Kata
cannot carry a host unix socket into the guest, because virtio-fs hands a
socket's `connect()` to the guest kernel. So Kata needs the veth-and-nftables
path from "Alternatives not taken", with netd's rule code on the host and
identity by source IP. That is a second egress design, and the reason Kata
is out of this plan. Hetzner Cloud and most cloud VMs have no KVM anyway,
so gvisor covers them.

## Testing

- **Unit (`unit:server`).** `test/drivers/sandbox/` mirrors the folder. Mock
  only the backend modules, backed by a `fakeContainerEngine` in
  `packages/test-utils` that a test seeds and asserts on, including the
  mount list each backend produced. Each test file has one `describe` per
  barrel function defined in its module.
- **Proxy.** The local feed and per-listener identity get their own tests;
  `test/apiserver` keeps covering the k8s feed.
- **Route matrix.** A third column, `sandbox`, on every row, with a `why`
  wherever it differs. A new project, `api-sandbox`, runs the real driver
  against the fake engine, on any machine.
- **e2e.** `test/e2e-sandbox/` runs on a host against whichever backend it
  has: Linux CI covers gvisor and a Mac covers apple. The global setup
  builds the `yaac-test-*` images with that engine, using the same hash
  tags and `requirePrebuilt`. `test/e2e-cli/engine-cli-suite` covers every
  `yaac engine` option.
- **Isolation.** One e2e case per backend tries, as root in the workspace:
  - to write the read-only `.git`, including after a remount;
  - to read another project's dir;
  - to plant a link the server then reads;
  - to reach a host listener, a second workspace and a literal internet
    address;
  - to connect to a host socket outside its socket dir.

  All must fail, while an allowlisted host through the proxy succeeds.
- **Dev workspaces cannot run `e2e-sandbox`.** It runs on a host, like the
  k8s tiers.

## Docs to write or change

- `docs/sandbox-driver.md`, the reference, folded from this plan.
- `docs/layered-server.md` and CLAUDE.md's runtime section: three drivers
  and traits.
- `docs/containerless-driver.md`: its intro says there are two substrates.
- `docs/workspace-egress.md`: the local feed, socket identity and netshim.
- `docs/workspace-storage.md`: the sandbox column of the mount mapping.
- `docs/server-selection.md`, `docs/port-forward-tunnel.md`,
  `docs/image-gc.md`, `docs/trust-split-builds.md`,
  `docs/nested-containers.md`: their sandbox sections, as each phase
  lands.

No legacy-compat shim is needed: no existing install records `sandbox`.

## Spikes

1. **runsc under nerdctl.** Confirm a containerd runtime handler can carry
   runsc's config (`host-uds`, overlay) when nerdctl starts the container,
   that the `dev.gvisor.spec.mount.*` annotations apply to a standalone
   container as they do in a pod, and that `host-uds=open` and `create`
   both work with `--network none`. If nerdctl cannot pass the handler's
   options, the fallback is the containerd API through a small client.
2. **Sinkhole addresses.** Whether gVisor's netstack and Apple's guest let
   root add the sinkhole addresses to loopback, or netshim must use
   addresses loopback already answers.
3. **Read-only against guest root**, on both. Write the `.git` bind after
   `mount -o remount,rw` as root. gVisor's gofer should refuse. Apple's is
   unknown, and a failure there blocks the apple backend.
4. **Socket egress**, on both. Measure throughput and latency for a
   streaming model request, a large `git clone` and an `npm install`, with
   50 concurrent connections. Confirm a proxy restart, which recreates the
   listener at the same path, is picked up without restarting the
   workspace.
5. **Mount performance and coherence.** `git status` on a 100k-file
   checkout. A tool home written by two workspaces at once (claude's
   `.claude.json`), compared with today's NFS. SQLite WAL on each bind
   type.
6. **Apple specifics.**
   - Confirm Apple's virtiofs reports the caller as owner, as lima#1513
     describes for the same framework.
   - Find the share-count limit per VM.
   - Check that `logs -f` ends on stop.
   - Measure memory growth over a long session, to set the default limit.
7. **Boot to ready** per backend. This decides the spare pool.

## Risks and open questions

- **Root, the same as today.** macOS needs none: the server, `container`
  and the proxy all run as the user. Linux needs a one-time sudo setup
  (containerd, nerdctl, buildkitd, runsc, socket access) that yaac prints
  but does not run, as it does for the rootful podman socket today. The
  containerd socket is root-equivalent, as the podman socket is now. A
  dedicated box may prefer to run the server as root under systemd; that
  is a deployment choice, not a requirement.
- **A young Apple runtime.** Pin a minimum version, check it at start, and
  keep every invocation in `apple.ts`.
- **The engine is the user's.** The user can see and delete yaac's
  containers. The `yaac` namespace and labels identify them, and a deleted
  one is an ordinary death.
- **`host-uds=all` widens what a gVisor sandbox may connect to** from no
  host sockets to any socket it can see. Rule 5 keeps the only visible one
  the workspace's own, and the isolation e2e case checks it.
- **No npm cache.** Packages come through the proxy. A shared cache can be
  a later phase.
