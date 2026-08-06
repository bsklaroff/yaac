# Multi-node storage plan: shared project data across nodes

Goal: move yaac from the single-node kind cluster toward a multi-node
cluster where session pods of one project can run on different nodes while
sharing per-project state (`claude/`, `repo/.git`, caches) as if they were
on the same node — without giving up the containment invariant: in-container
root (passwordless sudo is a feature) must never be host root.

That invariant is now held by **gVisor's sentry**, not `hostUsers: false`.
The runtime flip that enables shared storage is **done**; the shared
filesystem itself is the remaining work.

## Where things stand

- **Runtime — done.** Every pod yaac creates runs under gVisor (runsc) with
  no user namespace. The sentry is the containment for in-container root and
  hardens the whole fleet against host-kernel escapes. There is no runc
  session tier: gVisor is non-optional for sessions.
- **Storage — unchanged (single-node).** Session mounts are still `hostPath`
  volumes resolving on the node, made equivalent to the host filesystem by
  the kind `extraMounts: $HOME → $HOME` bind. The shared filesystem across
  nodes (NFS) is not yet built — the sections below are the plan for it.

## The gVisor runtime (implemented)

Every yaac-managed pod — session pods (plain *and* nested), the egress
proxy, per-project registries, vcluster control planes and their synced
pods, probe pods — runs under a `gvisor` RuntimeClass (runsc), no userns.
Cluster infrastructure in kube-system (Calico, CoreDNS, control plane) stays
on runc — Calico *is* the host datapath and cannot be sandboxed away from
the host kernel (the same scoping GKE Sandbox uses). "Every yaac pod" is the
scope.

### Why gVisor (the enabler)

`hostUsers: false` (a user namespace) existed for one reason: in-pod root
must not be host root. But the kubelet applies an idmapped mount
(`mount_setattr`) to **every** volume of a userns pod, so each volume's
backing filesystem must support idmapped mounts. NFS does not (the uid
mapping is VFS-local and cannot travel over the wire), which ruled out a
plain-NFS shared root.

Under runsc, in-sandbox root is a sentry fiction — the application kernel is
the boundary — so a gVisor pod drops the userns without losing containment
(the combination isn't even available: runsc has no idmapped-mount support).
With the userns gone the kubelet performs no `mount_setattr`, so the backing
filesystem no longer needs idmap support: NFS becomes usable, with the host
kernel as the NFS client and runsc's gofer proxying pod I/O against whatever
the host mounted (the sentry is backing-filesystem-agnostic).

Idmap support by filesystem, for reference (kernel 7.0 / K8s 1.36):

| Filesystem | Idmapped mounts |
|---|---|
| ext4 / xfs / btrfs / tmpfs / overlayfs | ✓ (≥5.12–6.3) |
| CephFS kernel client | ✓ (≥6.7, Reef+ MDS) |
| FUSE | ✓ kernel-side (≥6.12), daemon must opt in |
| NFS client | ✗ (the "notable absence") |

Dropping the userns as containment also deleted real complexity: the
rootless-podman contortions in the nested image are gone, and the userns-tier
node prerequisites lose their rationale. The unmasked-sysfs fixup (kind#3436)
is removed; the idmapped-mount filesystem constraints (ext4/xfs on Linux, the
macOS libkrun-efi ≥ 1.17 floor) no longer bind — though libkrun stays yaac's
macOS podman-machine provider for now, pending a fresh-setup test on the
default provider. And per-workload capability carve-outs stopped being
security decisions: in-sandbox caps grant no host authority.

References:
[Kernel Recipes: idmapped mounts](https://archives.kernel-recipes.org/wp-content/uploads/2025/01/brauner_christian_idmapped_mounts.pdf),
[Docker in gVisor tutorial](https://gvisor.dev/docs/tutorials/docker-in-gvisor/).

### Cluster setup and manifests

`yaac cluster setup` (full and `--repair`) applies the `yaac-gvisor-install`
DaemonSet, which installs pinned runsc + containerd-shim-runsc-v1 on every
node it lands on (systrap platform — no `/dev/kvm`), patches that node's
containerd config with two handlers and labels it; setup then applies two
RuntimeClasses, which schedule on that label:

- `gvisor` — the default. Every session, the proxy, registries, and probe
  pods run on it.
- `gvisor-nested` — adds `--net-raw` / `--allow-packet-socket-write` for the
  in-sandbox container engine.

Both handlers set `host-uds=all` (the tmux socket lives on a gofer-backed
volume and must rendezvous across sandboxes as a real host socket)
and `allow-suid` (runsc drops the setuid bit by default,
google/gvisor#5299 — the image's passwordless `sudo` is a feature, and the
rootful engine bootstrap needs it). Every manifest builder stamps
`runtimeClassName` explicitly (no webhooks); cluster check has a `gvisor`
gate (RuntimeClasses present + a labelled node to schedule on + a pod
provably sentry-sandboxed via its dmesg fingerprint) and a `runtime-stamp`
sweep.

### Nested sessions: rootful engine in the sentry

Nested sessions run the container engine as **real root inside the sentry**
on `gvisor-nested` — the upstream docker-in-gvisor shape. Rootless is not an
option: the sentry allows a single-id userns (`unshare -U -r`) but refuses
the multi-range `uid_map` write rootless engines need (`newuidmap: open of
uid_map failed`), verified on the dev cluster. Decisions:

- **Image is rootful-only.** The rootless apparatus (subuid/subgid maps,
  `newuidmap`/`newgidmap` caps, `userns=host`, `keyring=false`,
  `no_pivot_root=true`, the `/proc` bind) is gone — pivot_root, fresh
  `/proc`, and kernel keyrings all work as real root under the sentry.
  Engine config lives at the rootful system paths
  (`/etc/containers/{containers,storage}.conf`).
- **Graphroot is a tmpfs.** `security.capability` (what `docker build`
  `setcap` steps write) sticks only on a sentry-internal tmpfs — goferfs
  refuses writes to the `security.*` xattr namespace on gofer-backed
  (hostPath/emptyDir) volumes, and fuse-overlayfs the sentry refuses to
  mount. So the graphroot is a Memory emptyDir promoted to a sentry tmpfs
  via a `dev.gvisor.spec.mount.<vol>.type=tmpfs` annotation, sized below
  the pod memory limit (a huge build ENOSPCs rather than OOMs; layer data
  is in RAM).
- **Engine caps.** `NESTED_ENGINE_CAPS` (SYS_ADMIN, SYS_CHROOT, MKNOD,
  SETFCAP, NET_RAW, NET_ADMIN, SYS_PTRACE, SYS_RESOURCE) — no host authority
  under the sentry.
- **The yaac user reaches the root engine over the socket.** The agent runs
  as `yaac`; `sudo podman system service` serves the rootful socket, which
  session-create opens to `yaac`. `DOCKER_HOST` and `CONTAINER_HOST` both
  point there (podman auto-enters remote mode on `CONTAINER_HOST`), so bare
  `docker`/`podman` — the agent's and an inner yaac's image machinery
  (pull/tag/push) — hit the same engine. `sudo` strips these vars, so the
  root service + the imagestore promoter (`sudo -H`) stay local.
- **CA trust for the engine.** `sudo` resets the pod env, so the rootful
  service exports `SSL_CERT_FILE=<combined bundle>` inside its own shell to
  trust the MITM proxy CA on registry pulls. Nested containers and build RUN
  steps get their CA trust from the mounted containers.conf.
- **Cross-session image cache needs no node-local mount.** It rides the
  project's own in-cluster registry: the session pushes its images out over
  netstack and a later session pulls them back in (image-promoter.ts, and
  docs/nested-containers.md for the manifest-type constraint the push
  respects). Nothing about it pins a session to the node its predecessor
  ran on, and the gofer is not in the path — the graphroot is a sentry
  tmpfs, so pushes read layers at native speed instead of extracting them
  file-by-file.

### vcluster

The control-plane StatefulSet (post-render stamp) and every synced pod
(`sync.toHost.pods.runtimeClassName` in values.yaml) run on `gvisor`. The
synced-pod VAP guard admits `capabilities.add` only behind the sentry tier
(`variables.sandboxed` — the runtimeClassName the syncer stamps), so the
rootful nested session's in-sandbox caps pass while an unsandboxed cap grant
is denied. Verified end to end (session-create-vcluster, yaac-in-yaac).

### The proxy control tunnel

`kubectl port-forward` cannot reach a gVisor pod — containerd dials
localhost inside the pod netns, where the sentry's netstack listener is
invisible, so the tunnel gets ECONNREFUSED against a Ready pod. The server's
proxy control tunnel is an exec+socat loopback relay (`lib/k8s/exec-tunnel.ts`)
instead. **Anything future must not assume port-forward works against a
gVisor pod.**

### Verified

Cluster check all-green (sentry probe, hostPath write at the session uid,
egress default-deny + forgery lock); transparent-egress 8/8 with proxy AND
session pods sandboxed; nested-containers 3/3 (rootful in-pod build + pull
through the MITM proxy + cross-session cache reuse); session-create-vcluster
and yaac-in-yaac green; full server unit suite green.

## Remaining: shared filesystem across nodes

The runtime is ready; the shared storage is not. All state lives under
`<dataDir>/projects/<slug>/`:

- Project-scoped, shared across sessions: `claude/`, `claude.json`, `codex/`,
  `pi/`, `opencode-config/`, `.cached-packages/`, `repo/.git`.
- Per-session: `worktrees/<sid>` (→ `/workspace`), `sessions/<sid>/` (tmux
  socket, vcluster kubeconfig, nested data), ephemeral module dirs.

Invariants any shared-FS design must keep:

1. **The server shares the filesystem.** It is a host process that creates
   worktrees (`addWorktree`), seeds `claude/settings.json` + placeholder
   credentials, reads transcripts, and `rm -rf`s session dirs on cleanup. No
   host-mountable PVC exists, so "move mounts to PVCs" would force all of
   this into pods.
2. **Worktree ↔ repo gitdir pointer**: `/workspace/.git` references
   `/repo/.git/worktrees/<sid>` — both sides must be reachable wherever git
   runs.
3. **pnpm hardlink affinity**: ephemeral module dirs live under
   `.cached-packages` so `link(2)` from the pnpm store doesn't hit EXDEV.
4. ~~**tmux socket**~~ — unix sockets rendezvous only within the kernel
   that bound them, so it was never shareable; it is a pod-local emptyDir
   now and no longer constrains the shared root.

**Primary path: plain NFS as the shared root** — a stock kernel NFS mount at
the same absolute path on the server host and every node. It is the most
boring option (no FUSE idmap patch, no metadata engine, no unproven protocol
path), unlocked entirely by the gVisor flip. JuiceFS and CephFS are
fallbacks (below).

### Prove the topology (no storage change)

Multi-node kind on one host: all node containers see the same host
filesystem, so extending `extraMounts: $HOME → $HOME` to every node keeps
hostPath + ext4 working while exercising real multi-node scheduling.

- [x] kind config with 2–3 nodes, `extraMounts` on each — `yaac cluster
      setup --nodes N` renders the bundled config's one control-plane entry
      into N-1 worker copies, so the `$HOME` bind lands on every node
      (docs/cluster-setup.md, "Multi-node").
- [x] Make the local registry reachable from every node — it already was:
      the registry container joins the podman `kind` network (every node
      container is on it) and the containerd `hosts.toml` fixup, like every
      other per-node step in setup, loops the enumerated node set. `yaac
      cluster check`'s `registry-nodes` gate now proves it per node by
      pulling `Always` from a pod pinned to each.
- [x] Audit node-local paths — `/var/lib/yaac/imagecache/<hash>` is dead
      (the cross-session cache moved into the project registry); only the
      one-shot sweep pods touch it, and they already run on every node.
      `/var/lib/yaac/registry/<hash>` is live and per-node, and stays
      acceptable: a registry pod that lands on a different node starts cold,
      the prime side treats a missing image as a miss, and session images
      themselves come from the host-side registry.
- [ ] Run the e2e suite against the multi-node cluster.

### NFS spike (go/no-go)

- [ ] Stand up an NFS export (server host initially): `sec=sys`, no
      `all_squash`/uid remapping — numeric uids pass through raw under
      gVisor, so the export must preserve the sessionUid alignment on every
      host.
- [ ] Automount the export at the same absolute path on the server host and
      every node (the mount must exist before kubelet resolves hostPath
      volumes into it).
- [ ] Probe chain, cheapest first: (1) server-host git clone + `git worktree
      add` + pnpm store ops on the NFS mount; (2) a gVisor pod with a
      hostPath into the NFS automount — creation ownership, O_EXCL, atomic
      rename, hardlinks, fcntl locks; (3) a full yaac session with `claude/`
      + `repo/.git` on NFS.
- [ ] Cache coherence: enumerate every dir with an **external writer**
      (server seeds `claude/settings.json` + credentials, `addWorktree`
      writes `repo/.git`, transcript readers tail from the host) and set
      shared file-access on those mounts (runsc `--file-access-mounts=shared`
      / per-mount `dev.gvisor.spec.mount.*` annotations). Two cache layers
      stack: gofer cache over NFS attribute cache.
- [ ] Locks: confirm sentry POSIX locks stay sandbox-local (they never reach
      the NFS server) and audit that nothing on the shared root relies on
      cross-host flock.
- [ ] Benchmark `git status` / `git checkout` and transcript append/tail
      through sentry→gofer→NFS vs the hostPath-on-ext4-under-gVisor baseline.
- No-go on NFS (but gVisor healthy) → try CephFS under gVisor (no idmap
  needed either).

### Split shared vs node-local roots

Keep hot per-session dirs off the shared FS regardless of which one wins.

- [x] **The path layer is classified.** `paths.ts` hands out one root per
      tier — `sharedRoot()` (server *and* pods, any node), `nodeLocalRoot()`
      (one node's scratch), `serverLocalRoot()` (the server process only) —
      plus the joiners every helper is built from (`sharedPath`,
      `sharedProjectPath`, `nodeLocalProjectPath`, `serverLocalPath`). All
      three resolve to `getDataDir()`, so the single-node backend is
      byte-identical; the tier is a declared visibility requirement, not yet
      a different volume. Every helper in `project-paths.ts` carries its tier
      in its doc comment, and eslint blocks importing the untiered root in
      every package's `src`, so a new helper cannot skip the declaration.

      Where things landed: **`packages/shared/src/project-paths.ts` is the
      single source** — each helper carries its tier in its doc comment, so
      a per-directory table here would only drift. The shape: the
      `projects/<slug>` tree is SHARED, with three carve-outs — the tmux
      socket dir (a UNIX socket only rendezvous inside the kernel that
      bound it), `opencode-data/<sid>` (SQLite, no WAL on a network FS), and
      `.cached-packages` (the per-node pnpm store this plan recommends).
      `.credentials/` and the proxy's `run/proxy-data` are server-owned but
      SHARED, because the proxy pod mounts them; handing the proxy its
      credentials over the API or a Secret would move them to SERVER-LOCAL,
      where secrets belong. Everything else at the top level (`db/`, logs,
      preferences, locks, `build/`, `models/`, caches) is SERVER-LOCAL.

      Three tiers, not two: the plan already gives the server's own state a
      different volume (RWO block storage, §1 of the stock-k8s plan), and
      pglite must never sit on a network FS — folding it into "shared" would
      encode the wrong requirement.

      Sweeps that must see a whole session or project go through the
      `sessionRoots` / `sessionsRoots` / `projectRoots` / `projectsRoots`
      pairings the path layer exports (deduplicated, so one pass today):
      session cleanup, the orphan GC — whose slug source is both
      `projects/` trees, not just the shared one — and `project remove`.

      Still to do, all of it in the volume-source work rather than the path
      layer: `worktrees/<sid>` is shared *deliberately* (see below); the
      server currently `mkdir`s node-local dirs (opencode-data,
      `.cached-packages`) from its own filesystem, which needs an emptyDir
      or an init container once the roots differ; the node-local sweeps
      still have to RUN per node; and `ensureDataDir()` pre-creates only
      the shared tree (server-local writers mkdir their own root).
- [x] tmux socket dir → emptyDir: **done**, alongside the `pod-spec.ts`
      volume-source seam (it was a volume-shape change, not a
      path-vocabulary one). The only thing ever written into the dir is the
      socket itself (`server`), nothing off the pod opens it, and
      `sessionTmuxDir()` is gone with the host dir it named.
- [ ] pnpm store placement: recommended **per-node store** (node-local, fast,
      duplicate downloads per node) over store-on-shared-FS (every
      `link(2)`/stat becomes a remote round trip).
- [ ] Worktree creation: the server runs `git worktree add` on its own host
      against `repo/.git`. With repo shared and worktrees node-local, the
      worktree dir must be created on the session's node — keep worktrees on
      the shared FS initially (simplest), or move creation into an init
      container (later).
- [ ] PGlite server DB (`<dataDir>/db`): stays on server-local disk (embedded
      single-writer; never on a network FS). Carve out of the shared subtree.
- [ ] opencode per-session SQLite: node-local (SQLite forbids WAL on network
      FS; opencode has a confirmed NFS-corruption issue, anomalyco/opencode#14970).
      The server never opens the DB file (`opencode-status.ts` probes the
      in-pod HTTP API), so the only wrinkle is **resume on a different node**:
      start with restart node-affinity (resume pins to the node holding
      `opencode-data/<sid>`), upgrade to a boundary checkpoint (sqlite3_rsync
      / Litestream) if pinning hurts.

### Production shape

- [ ] NFS automount units on the server host + every node (same absolute
      path), ordered before kubelet; document node onboarding in
      docs/cluster-setup.md.
- [ ] NFS server operations: exports, snapshot/backup, monitoring — it is the
      SPOF for shared project state.
- [ ] Extend `yaac cluster check`: an NFS write-through probe (gVisor pod,
      hostPath into the shared root: create/ownership/rename/hardlink) and a
      coherence probe (host write → pod read latency and back).
- [ ] runsc upgrade cadence: it is the primary containment for every workload
      — pin, track releases/CVEs, and re-run the cluster-check probes on every
      bump.

## Fallbacks

If the shared filesystem specifically fails but gVisor is healthy:

- **CephFS via Rook** — works under gVisor with no idmap requirement (same
  gofer argument as NFS). Cost: operating Ceph (operator + mons + MDS).
  Re-run the NFS probe chain against it.
- **JuiceFS** (metadata engine + S3 chunks) — full POSIX, Apache-2.0. Under
  gVisor it needs no idmap patch (the gofer argument again); the FUSE-idmap
  research below only matters if the runtime itself is ever reverted to
  runc + userns. Cost: a Redis meta engine (a SPOF) + an object store.
- **Per-session local disk + explicit data plane** (kopia checkpoint/restore,
  Litestream for SQLite, transcript shipping) — no shared FS at all, but the
  most app code. Last resort.

**Stopgap — project→node affinity.** Each project pinned to a home node; pods
share via local ext4; the server reaches nodes over NFS (legal server-side).
Zero new storage tech in the pod path; caps a project's sessions to one node.
Useful for load-spreading before the shared FS lands.

<details>
<summary>FUSE-idmap research (only relevant if gVisor is ever reverted)</summary>

The kernel makes FUSE idmap conditional on a contract: the superblock must
use `default_permissions` (kernel does all UID/GID checks against inode
attrs) and the daemon must do **no** uid/gid-based checks of its own (with
idmap active, requests carry mapped ids on inode-creating ops and `-1`
elsewhere). JuiceFS does not yet set go-fuse's `IDMappedMount`; enabling it
is a small patch. Mount **without** daemon-side permission features (no
`--enable-acl`, no root-squash/uid-remap) so the kernel-checks-everything
contract holds; treat ACL support as incompatible with idmap until proven.
</details>

## Risks / open questions

- **Syscall-compat has no valve.** gVisor is non-optional for sessions (the
  break-glass runc tier was removed), so any tool hitting an unimplemented
  syscall is a hard failure, not a per-project fallback. Keep a running
  catalog of casualties; a growing catalog is the signal to reconsider.
- **Universal perf tax.** systrap overhead + the gofer hop apply to every
  session, and fork/exec-heavy work (git, package managers, builds) is
  gVisor's weakest axis. The shared-vs-node-local split keeps
  worktrees/modules node-local; the NFS spike measures the storage delta on
  top. A hot-path before/after benchmark is still outstanding.
- **Two caching layers on the pod path.** gofer caching will stack on NFS
  attribute caching; every externally-written dir must be mounted with
  shared file-access or staleness bugs will be intermittent and
  node-dependent. The NFS-spike coherence probes are the guardrail.
- **Sentry-local POSIX locks.** gVisor emulates fcntl/flock inside the
  sentry; locks never reach the NFS server, so cross-node lock coordination
  silently doesn't exist. Single-writer-per-session discipline must hold for
  everything on the shared root (it does today).
- **Uid passthrough discipline.** With no userns and no idmap, numeric uids
  flow raw across server host, nodes, and (eventually) the NFS export
  (`sec=sys`, no squash). The sessionUid = server uid = image yaac uid
  alignment must hold on every host.
- **runsc is the load-bearing runtime.** A pinned binary + node containerd
  config in `cluster setup`, a CVE stream to track, and a behavior surface to
  re-verify on upgrades. A sentry escape lands the attacker in an
  unprivileged host process; kube-system and the host stay runc/kernel-hardened.
- **NFS server availability.** The export will be a SPOF for all shared
  project state; needs a snapshot/backup story from day one.
- **tmux is already multi-node-clean (verified).** Every consumer reaches the
  socket via `kubectl exec` (interactive attach, the status watcher's `tmux
  -C` stream, the liveness `tmux has-session`), so the K8s exec API is the
  cross-node transport. Keep the hostPath tmux mount node-local; consider
  demoting it to an emptyDir once the pane log needn't outlive the pod.
- **Cleanup paths** (`cleanup.ts` `rm -rf`, orphan GC) touch both roots after
  the split; the GC sweep must enumerate node-local roots per node.
