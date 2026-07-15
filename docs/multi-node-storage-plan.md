# Multi-node storage plan: shared project data across nodes

Goal: move yaac from the single-node kind cluster toward a multi-node
cluster where session pods of one project can run on different nodes while
sharing per-project state (`claude/`, `repo/.git`, caches) as if they were
on the same node — without giving up the containment invariant: in-container
root (passwordless sudo is a feature) must never be host root. Today that
invariant is held by `hostUsers: false`; the end-state of this plan holds
it with gVisor's sentry instead.

**Primary path (this revision): gVisor as the default runtime for every
yaac-managed pod, plus plain NFS as the shared filesystem.** All workloads
yaac creates — session pods (default *and* nested), the egress proxy,
per-project registries, vcluster control planes and their synced pods,
promoter/probe jobs — run under a `gvisor` RuntimeClass (runsc), with the
user namespace dropped: the sentry replaces it as the containment layer,
and additionally takes host-kernel 0-days off the table for the whole
fleet. Dropping the userns removes the idmapped-mount requirement that
ruled NFS out, so the shared root becomes a stock kernel NFS mount at the
same path on the server host and every node. runc + userns is retained
only as an explicit break-glass compatibility fallback (node-pinned, no
NFS). Cluster infrastructure in kube-system (Cilium, CoreDNS, control
plane) stays on runc — Cilium *is* the host datapath and cannot be
sandboxed away from the host kernel; this is the same scoping GKE Sandbox
uses (system pods stay native). "Entire cluster" therefore means: every
pod yaac creates.

JuiceFS (the previous primary) and CephFS are demoted to fallbacks; their
research is preserved below.

## Current state (what multi-node breaks)

Every session mount is a `hostPath` volume resolving on the node, made
equivalent to the host filesystem by the kind `extraMounts: $HOME → $HOME`
bind (k8s/kind-config.yaml). All state lives under `<dataDir>/projects/<slug>/`:

- Project-scoped, shared across sessions: `claude/` (→ `/home/yaac/.claude`),
  `claude.json`, `codex/`, `pi/`, `opencode-config/`, `.cached-packages/`,
  `repo/.git` (→ `/repo/.git`).
- Per-session: `worktrees/<sid>` (→ `/workspace`), `sessions/<sid>/`
  (tmux socket, vcluster kubeconfig, nested data), ephemeral module dirs.

Invariants the current design relies on:

1. **Server shares the filesystem.** The server is a host process that
   creates worktrees (`addWorktree`), seeds `claude/settings.json` and
   placeholder credentials, reads transcripts (`restart.ts`,
   `claude-status.ts`, `pi-status.ts`, `list.ts`), and `rm -rf`s session
   dirs on cleanup. No PVC of any access mode is host-mountable, so a
   "move mounts to PVCs" refactor also forces all of this into pods.
2. **Worktree ↔ repo gitdir pointer**: `/workspace/.git` references
   `/repo/.git/worktrees/<sid>` — a path reference (cross-filesystem OK),
   but both sides must be reachable wherever git runs.
3. **pnpm hardlink affinity**: ephemeral module dirs live under
   `.cached-packages` so `link(2)` from the pnpm store doesn't hit EXDEV
   (same superblock required).
4. **tmux socket** in `sessions/<sid>/tmux` — unix sockets rendezvous only
   within the kernel that bound them (node-local by nature).

## The gating constraint on runc + userns: idmapped mounts

Session pods run `hostUsers: false` (user namespaces) today. The
kubelet/runtime applies an idmapped mount (`mount_setattr`) to **every**
pod volume, so the filesystem backing each volume must support idmapped
mounts or the pod fails to start (`mount_setattr … Invalid argument`).
Dropping `hostUsers: false` while staying on runc is not on the table (it
is the containment layer for in-container root/sudo).

Idmap support by filesystem (as of kernel 7.0 / K8s 1.36 GA docs):

| Filesystem | Idmapped mounts | Notes |
|---|---|---|
| ext4 / xfs / btrfs / tmpfs / overlayfs | ✓ (≥5.12–6.3) | why today's setup works |
| CephFS kernel client | ✓ (≥6.7) | needs Reef+ MDS (`CEPHFS_FEATURE_HAS_OWNER_UIDGID`); `enable_unsafe_idmap` for older MDS |
| FUSE | ✓ kernel-side (≥6.12) | **daemon must opt in**: `FUSE_ALLOW_IDMAP` + `FUSE_OWNER_UID_GID_EXT` init flags + `default_permissions` |
| NFS client | ✗ | the K8s docs' "notable absence"; upstream considers it near-impossible (the uid mapping is VFS-local and cannot travel over the wire) |

Consequence: plain NFS is dead for pod-visible storage **as long as the pod
runs in a user namespace**. The constraint applies only to *pod volume
mounts* — the server (host process, no userns) may use NFS freely.

### Why gVisor dissolves the constraint

`hostUsers: false` exists for exactly one reason: in-pod root must not be
host root. Under runsc, in-sandbox root is a sentry fiction — the
application kernel is the boundary — so a gVisor pod drops the userns
without losing that containment. (The combination isn't even available:
runsc has no KEP-127 idmapped-mount support, so userns pods can't run on
it anyway.) With the userns gone, the kubelet/runtime performs no
`mount_setattr`, and the backing filesystem no longer needs idmap support.

NFS then works with no NFS-awareness anywhere in the pod path: the host
kernel is the NFS client (kubelet/automount mounts the share on the node),
and runsc's gofer proxies file I/O against whatever the host mounted —
the sentry is backing-filesystem-agnostic.

With gVisor as the default runtime for *all* yaac pods, this holds
fleet-wide: any session can schedule on any node once its data is on the
shared root. Only break-glass runc sessions (see Phase 1) keep the userns,
and with it the idmap constraint — they stay node-pinned on local ext4.

### What going gVisor-default simplifies

Beyond the storage unlock and the sandbox upgrade, dropping userns as the
default containment deletes real complexity:

- The rootless-podman contortions in the nested image (subuid/subgid
  gymnastics, `newuidmap`/`newgidmap` file caps, `no_pivot_root`,
  `keyring=false`) exist only because in-pod root shares the host kernel.
  Under the sentry the engine runs as plain root in-sandbox (the
  upstream-tested docker-in-gvisor shape) — see Phase 2.
- The kind-node unmasked-sysfs requirement (kind#3436) and the
  idmapped-mount filesystem constraints — including the macOS
  libkrun-efi ≥ 1.17 requirement (virtiofs FUSE idmap) — were all
  userns-tier prerequisites. They demote to break-glass-fallback-only.
- One containment story instead of two: every yaac pod is "inside the
  sentry", full stop. In-sandbox capabilities grant no host authority, so
  per-workload capability carve-outs (the nested SYS_ADMIN, the proxy's
  NET_BIND_SERVICE) stop being security-relevant decisions.

References: [soperator #1510](https://github.com/nebius/soperator/issues/1510)
(the `hostUsers: false` + NFS failure in the wild),
[Kernel Recipes: idmapped mounts](https://archives.kernel-recipes.org/wp-content/uploads/2025/01/brauner_christian_idmapped_mounts.pdf),
[Docker in gVisor tutorial](https://gvisor.dev/docs/tutorials/docker-in-gvisor/)
(the nested-tier migration shape, Phase 2).

## Options considered

| Option | Verdict |
|---|---|
| NFS shared `<dataDir>`, pods on runc + userns | ✗ pod mounts fail under userns; hard kernel limitation |
| **NFS shared root + gVisor as the default runtime for all yaac pods (runsc, no userns)** | **✓ primary** — stock kernel NFS client on the host; gofer proxies I/O; no idmap needed; sentry replaces userns as containment fleet-wide and hardens the whole cluster against host-kernel escapes. Costs: universal gofer/systrap perf tax, the nested tier must migrate to rootful-engine-in-sandbox, runsc becomes the load-bearing runtime. |
| Direct S3-FUSE mappers (s3fs, goofys, GeeseFS, Mountpoint-S3, rclone mount) | ✗ regardless of idmap: no/fake hardlinks, renames, locks — git/pnpm/SQLite can't run |
| Per-session local disk + explicit data plane (kopia checkpoint/restore to object store, Litestream for SQLite, transcript shipping over WS) | ✓ works, no shared FS at all — but the most app code: server-decoupling refactor, checkpoint semantics, consistency discipline. Last-resort fallback. |
| Project→node affinity (each project pinned to a home node; pods share via local ext4; server reaches nodes over NFS, which is legal server-side) | ✓ zero new storage tech in the pod path; caps a project's sessions to one node. Good stopgap while Phases 1–2 land. |
| CephFS via Rook | ✓ proven idmap-capable RWX; keeps userns on all tiers. Cost: operating Ceph (operator + mons + MDS). Fallback #2. |
| JuiceFS (metadata engine + S3 chunks) with idmap patch | ✓ full POSIX, keeps userns on all tiers; needs a go-fuse `IDMappedMount` enablement patch + a metadata engine (Redis) + object store. Previous primary; now Fallback #1 — the recovery path if the runtime flip itself no-goes (research preserved below). |

Why gVisor + NFS over JuiceFS as first choice: the same architectural
outcome (one POSIX mount at the shared root on every node **and** the
server host, near-zero yaac storage code), but the storage layer is the
most boring technology available — stock kernel NFS, no FUSE idmap patch,
no metadata engine to operate, no unproven protocol path. And the
enabling change is not storage machinery at all: it is a fleet-wide
security upgrade (userspace-kernel sandboxing for every workload yaac
runs) that also deletes the rootless-nested contortions and the idmap
prerequisites. The trade is a universal runtime perf tax (benchmarked in
Phase 3, mitigated by the Phase 4 hot/cold split) and a real migration
for the nested tier (Phase 2).

## Plan

Dependency shape: Phase 1 gates everything; Phase 2 (nested) and Phase 3
(NFS) are independent of each other and can proceed in parallel.
Multi-node scheduling of *nested* sessions needs both.

### Phase 0 — prove the topology (no storage change)

Multi-node kind on one host: all node containers see the same host
filesystem, so extending `extraMounts: $HOME → $HOME` to every node keeps
hostPath + ext4 working unchanged while exercising real multi-node
scheduling.

- [ ] kind config with 2–3 nodes, `extraMounts` on each.
- [ ] Make the local registry reachable from every node (Service/hosts.toml
      on all nodes, not just control-plane).
- [ ] Audit node-local paths for multi-node behavior:
      `/var/lib/yaac/imagecache/<hash>` and `/var/lib/yaac/registry/<hash>`
      become per-node (acceptable: cold cache on other nodes) — verify
      nothing *breaks*, only warms slower.
- [ ] Run the e2e suite against the multi-node cluster.

### Phase 1 — gVisor as the default runtime (no storage change)

Flip the fleet, workload class by workload class. Independently useful
(sandbox upgrade for the whole cluster) and de-risks the NFS spike.

- [ ] Install runsc + containerd-shim-runsc-v1 on every kind node (pinned
      version via the pinned-binary pattern; systrap platform — no
      /dev/kvm; the kind node is a privileged container, a known-working
      combination), patch the node containerd config, register the
      RuntimeClasses. Fold into `yaac cluster setup`. Two handlers:
      `gvisor` (default) and `gvisor-nested` (adds `--net-raw`,
      `--allow-packet-socket-write`, and — if the Phase 2 graphroot
      ladder lands on fuse-overlayfs — `--fuse`), so raw-socket allowance
      stays scoped to the workloads that need it.
- [ ] Stamp `runtimeClassName` explicitly in every yaac manifest builder
      (kubectl-shell-out style, no webhooks): the session Job, the proxy
      Deployment, per-project registry pods, promoter/probe/node-write
      pods, vcluster helm values. A cluster-check probe asserts no
      yaac-namespace pod runs without it.
- [ ] Session pods: set `runtimeClassName: gvisor` and **drop
      `hostUsers: false`** (the sentry is the containment). Everything
      else stays byte-identical (seccomp RuntimeDefault is ignored by
      runsc, which installs its own host seccomp).
- [ ] Break-glass fallback: a per-session override back to runc + userns
      for syscall-compat casualties. Documented consequences: node-pinned
      (idmap constraint returns), keeps all userns prerequisites. This is
      the pressure valve, not a tier — the default is gVisor everywhere.
- [ ] Verify the egress security model end-to-end under gVisor's
      netstack: the cluster-level Cilium redirect + SNI interception are
      host-side (veth-level) and expected unaffected, but this is
      load-bearing — verify redirect, SNI/Host routing, and the DNS-stub
      path (udp/53 into the sandboxed proxy).
- [ ] Proxy + registry under gVisor: SNI/Host routing is pure userspace
      and the DNS stub binds via in-sandbox NET_BIND_SERVICE — low risk;
      verify inbound redirected connections and upstream dials through
      netstack.
- [ ] Run the full default-tier e2e suite with the gVisor default.

### Phase 2 — nested tier on gVisor (rootful engine in the sandbox)

The nested contortions exist because in-pod root shares the host kernel;
under the sentry they are deleted, not ported. Upstream's docker-in-gvisor
shape: a **rootful** engine inside the sandbox, broad in-sandbox caps
(they grant no host authority), `--network=host`, iptables-free — the
last two are already yaac's nested config (`netns=host`, no bridge
networks, `cgroups="disabled"`).

- [ ] Rework the nestable image for rootful-in-sandbox podman: drop the
      subuid/subgid maps, `newuidmap`/`newgidmap` file caps, and the
      userns-scoped SYS_ADMIN grant; keep `netns=host`, the CA-trust
      plumbing, and the containers.conf shape.
- [ ] Graphroot storage ladder, cheapest capable rung wins:
      (1) guest overlayfs over the gofer-backed emptyDir graphroot;
      (2) fuse-overlayfs via runsc `--fuse` (same containers/storage
      overlay layout — the shared-store format survives);
      (3) tmpfs graphroot (the tutorial's shape) — layer data then counts
      against `memoryLimitBytes`; size accordingly.
- [ ] Cross-session shared image store: verify `additionalimagestores`
      lowerdirs over a gofer-served hostPath (the sentry's overlay does
      not care what the host fs is — plausibly *more* permissive than
      kernel overlayfs). Fallback: warm pulls through the per-project
      registry instead of the shared store.
- [ ] The imagestore promoter (podman write-side) migrates with this
      class.
- [ ] Build-time syscall/xattr coverage sweep: real-world `docker build`s
      (apt postinsts doing `setcap`/`security.capability`, mknod, etc.)
      against the sentry; catalog failures for the break-glass list.
- [ ] Nested egress under netstack: nested containers share the pod netns,
      so traffic exits via netstack onto the same veth — verify the
      Cilium redirect + MITM CA path from inside a nested container.
- [ ] vcluster: control-plane pod under gVisor (verify the distro:
      apiserver/kine/SQLite are plain userspace, expected fine); stamp
      `runtimeClassName: gvisor` on synced workload pods via vcluster
      sync config, and extend the VAP pod guard to require it.
- [ ] Run the nested + session-create e2e families under gVisor.
- Until this phase lands, nested sessions run on the break-glass runc
  path (node-pinned) — the affinity stopgap covers them.

### Phase 3 — NFS spike (go/no-go)

- [ ] Stand up an NFS export (server host initially): `sec=sys`, no
      `all_squash`/uid remapping — numeric uids pass through raw under
      gVisor (no userns, no idmap), so the export must preserve the
      existing sessionUid alignment on every host.
- [ ] Automount the export at the same absolute path on the server host
      and every node (ordering: the mount must exist before kubelet
      resolves hostPath volumes into it).
- [ ] Probe chain, cheapest first:
      1. Server-host side: git clone + `git worktree add` + pnpm store ops
         directly on the NFS mount (server-side NFS was always legal —
         baseline + sanity).
      2. gVisor pod with a hostPath into the NFS automount: creation
         ownership, O_EXCL, atomic rename, hardlinks, fcntl locks.
         Control: the same spec on the runc break-glass path must fail
         `mount_setattr` (documents why break-glass sessions stay
         node-pinned).
      3. Full yaac session with `claude/` + `repo/.git` on NFS.
- [ ] Cache coherence: enumerate every dir with an **external writer**
      (server seeds `claude/settings.json` + credentials, `addWorktree`
      writes `repo/.git`, transcript readers tail from the host) and set
      shared file-access on those mounts (runsc
      `--file-access-mounts=shared` / per-mount `dev.gvisor.spec.mount.*`
      annotations). Verify host-written files appear promptly in-pod and
      pod-written transcripts tail promptly on the host — two cache
      layers stack here (gofer cache over NFS attribute cache).
- [ ] Locks: confirm sentry POSIX locks stay sandbox-local (expected — the
      sentry emulates them; they never reach the NFS server) and audit
      that nothing on the shared root relies on cross-host flock. SQLite
      is already node-local per Phase 4.
- [ ] Benchmark the hot operations through sentry→gofer→NFS: `git status`
      / `git checkout` on a real repo, transcript append/tail. Compare to
      the hostPath-on-ext4-under-gVisor baseline (Phase 1 makes gVisor
      the constant; this phase measures only the NFS delta). Phase 4
      keeps worktrees node-local, so these numbers gate only `claude/`,
      `repo/.git`, and caches.
- No-go on NFS (but gVisor healthy) → NFS is the storage problem: try
  CephFS under gVisor (no idmap needed either). No-go on gVisor itself
  (compat/perf) → Fallback #1 (JuiceFS): userns stays and storage does
  the adapting instead of the runtime.

### Phase 4 — split shared vs node-local roots

Regardless of which shared FS wins, keep hot per-session dirs off it.

- [ ] `project-paths.ts`: introduce a shared root (default `<dataDir>`) and
      a node-local root; move `worktrees/<sid>`, `sessions/<sid>`, and
      ephemeral modules to node-local; keep `claude/`, `claude.json`,
      `codex/`, `pi/`, `opencode-config/`, `repo/.git`, cache-volumes on
      the shared root.
- [ ] Decide pnpm store placement (hardlink affinity ties the store to the
      modules superblock): recommended **per-node store** (node-local, fast,
      duplicate downloads per node) over store-on-shared-FS (shared but
      every `link(2)`/stat is a remote round trip).
- [ ] Worktree creation: server currently runs `git worktree add` on its own
      host against `repo/.git`. With repo on the shared mount and worktrees
      node-local, the worktree dir must be created on the session's node —
      either keep worktrees on the shared FS initially (simplest, slower) or
      move worktree creation into an init container (later optimization).
- [ ] PGlite server DB (`<dataDir>/db`): must stay on server-local disk
      (embedded single-writer; never on a network FS). Carve out of the
      shared subtree.
- [ ] opencode per-session SQLite: node-local per this split (per-session
      dir) — never on the shared FS. SQLite's own docs forbid WAL on network
      filesystems (same-host shared-memory wal-index) and opencode has a
      confirmed NFS-corruption issue upstream (anomalyco/opencode#14970).
      yaac is already insulated on the read side: the server never opens the
      DB file — `opencode-status.ts` probes opencode's in-pod HTTP API and
      caches results in the server's own `opencodeSessionMeta` table (the
      SQLite-community-canonical "same host + proxy" pattern). Remaining
      wrinkle: **resume on a different node** — `opencode-data/<sid>`
      survives teardown for restart, so multi-node needs either (a) a
      boundary checkpoint (official `sqlite3_rsync`, WAL-aware, or a
      Litestream restore-on-create/replicate-during) to the object store, or
      (b) restart node-affinity (resume pins to the node holding the data).
      Start with (b) — zero new machinery; upgrade to (a) if pinning hurts.

### Phase 5 — production shape

- [ ] NFS automount units on the server host + every node (same absolute
      path), ordered before kubelet; document node onboarding (mount +
      runsc + kubelet prereqs) in docs/cluster-setup.md.
- [ ] NFS server operations: exports management, snapshot/backup story,
      monitoring — it is the SPOF for shared project state (the same duty
      the JuiceFS meta engine would have carried).
- [ ] Extend `yaac cluster check`: RuntimeClass probes (both handlers), a
      no-pod-without-runtimeClassName sweep of yaac namespaces, an NFS
      write-through probe (gVisor pod, hostPath into the shared root:
      create/ownership/rename/hardlink), the egress-under-gVisor probe,
      a nested build probe, and a coherence probe (host write → pod read
      latency and back).
- [ ] runsc upgrade cadence: it is now the primary containment for every
      workload — pin, track releases/CVEs, and re-run the cluster-check
      probe suite on every bump.
- [ ] Retire userns prerequisites from the default docs (unmasked sysfs,
      idmap fs checks, libkrun-efi floor) to a break-glass appendix.

## Fallbacks

### Fallback #1 — JuiceFS (metadata engine + S3 chunks) with idmap patch

The recovery path **if the runtime flip itself no-goes** (syscall compat
or perf): every pod keeps runc + `hostUsers: false`, and storage adapts
instead. Full POSIX (hardlinks, flock/fcntl, mmap, atomic rename;
pjdfstest-clean), Apache-2.0, S3/SeaweedFS backend. Kernel side is ready
(FUSE idmap ≥6.12; hosts run 7.0). JuiceFS does not yet set go-fuse's
`IDMappedMount`, but the library implements it — the enablement is a
small patch and a candidate upstream PR.

Spike, if invoked:

- [ ] Patch JuiceFS: expose a mount flag that sets go-fuse
      `MountOptions.IDMappedMount = true` (go-fuse auto-adds
      `default_permissions` and advertises `CAP_ALLOW_IDMAP`); bump the
      pinned go-fuse if needed.
- [ ] Stand up minimal backing: Redis (meta) + SeaweedFS or MinIO (data);
      `juicefs format` + mount on the host.
- [ ] Probe chain, cheapest first: (1) `mount -o X-mount.idmap=…` over a
      JuiceFS path (util-linux issues the same `mount_setattr` the runtime
      does); (2) `hostUsers: false` pod with a hostPath into the JuiceFS
      mount — uid mapping, creation ownership (`FUSE_OWNER_UID_GID_EXT`
      path), locks, hardlinks; (3) full yaac session with `claude/` on
      JuiceFS.
- [ ] Benchmark `git status`/`git checkout` and pnpm install with
      store+modules colocated.

**Why `IDMappedMount` is opt-in (researched, not a blocker).** The kernel
makes FUSE idmap conditional on a contract the daemon author must affirm:
the superblock must use `default_permissions` (kernel does all UID/GID
permission checks against inode attrs) and the daemon must do **no
uid/gid-based checks of its own** — with idmap active, requests carry
mapped ids on inode-creating ops and `-1` elsewhere, so any daemon logic
keyed on caller uid silently misbehaves. Libraries (go-fuse) and
filesystems can't flip this by default without changing permission
semantics for existing users. Consequence for the spike: mount JuiceFS
**without** daemon-side permission features — no `--enable-acl`, no
root-squash/all-squash/uid-remap options — so the kernel-checks-everything
contract holds. Verify chown/chmod and mode-bit enforcement behave under
the flag; treat JuiceFS ACL support as incompatible with idmap until
proven otherwise.

JuiceFS-specific risks: idmap unproven end-to-end (no public report
exercises kernel 7.0 + runtime `mount_setattr` + JuiceFS — inode-creation
ownership under `FUSE_OWNER_UID_GID_EXT` is the likeliest edge); metadata
latency on shared-mount git operations; the Redis meta engine is a SPOF
needing persistence + backups from day one.

### Fallback #2 — CephFS via Rook

If NFS specifically fails but gVisor is healthy, CephFS works under
gVisor with no idmap requirement (same gofer argument as NFS). If the
runtime flip fails too, CephFS is also the proven idmap-capable RWX for
the userns world (kernel client ≥6.7, Reef+ MDS). Cost: operating Ceph
(operator + mons + MDS). Re-run the Phase 3 probe chain against CephFS.

### Stopgap — project→node affinity

Each project pinned to a home node; pods share via local ext4; the server
reaches nodes over NFS (legal server-side). Zero new storage tech in the
pod path; caps a project's sessions to one node. Useful for load-spreading
before Phases 1–3 land, and covers break-glass runc sessions and the
nested tier until Phase 2 completes.

## Risks / open questions

- **Syscall-compat blast radius is now fleet-wide.** With gVisor as the
  default, any tool in any session hitting an unimplemented syscall is a
  production incident, not a tier-selection note. The break-glass runc
  override is the pressure valve; keep a running catalog of casualties,
  and treat a growing catalog as the no-go signal that flips the plan to
  Fallback #1.
- **The nested migration (Phase 2) is on the critical path.** "All pods
  on gVisor" is not true until rootful-engine-in-sandbox lands. Open
  items concentrate in storage: guest overlayfs over gofer-backed
  emptyDir (unproven; the tutorial uses tmpfs at `/var/lib/docker`, where
  layer data counts against `memoryLimitBytes`), `additionalimagestores`
  over gofer, and build-time xattr coverage (`security.capability`
  setcap in apt postinsts). The graphroot ladder in Phase 2 exists
  because rung 1 may well fail.
- **Universal perf tax.** systrap syscall overhead + the gofer hop now
  apply to *every* session, and fork/exec-heavy work (git, package
  managers, builds) is gVisor's weakest axis. Phase 1 must include a
  before/after benchmark on the hot paths; the Phase 4 split keeps
  worktrees/modules node-local; Phase 3 measures the NFS delta on top.
- **Egress model verification is load-bearing.** The Cilium redirect +
  SNI interception are host-side and expected unaffected by netstack,
  but the whole security posture rests on it — verify in Phase 1 for
  plain sessions and again in Phase 2 from inside nested containers.
- **vcluster control plane under gVisor is unproven.** Expected fine
  (plain userspace: apiserver, kine/SQLite), but it is the heaviest
  non-session workload; verify early in Phase 2. Synced-pod
  `runtimeClassName` stamping needs vcluster sync config + a VAP guard
  extension.
- **Two caching layers on the pod path.** gofer caching stacks on NFS
  attribute caching; every externally-written dir must be enumerated and
  mounted with shared file-access or staleness bugs will be intermittent
  and node-dependent. The Phase 3 coherence probes and the Phase 5
  cluster-check probe are the guardrails.
- **Sentry-local POSIX locks.** gVisor emulates fcntl/flock inside the
  sentry; locks never reach the NFS server, so cross-node lock
  coordination silently doesn't exist. Single-writer-per-session
  discipline must hold for everything on the shared root (it does today;
  keep it true).
- **Uid passthrough discipline.** With no userns and no idmap, numeric
  uids flow raw across server host, nodes, and the NFS export
  (`sec=sys`, no squash). The existing sessionUid = server uid = image
  yaac uid alignment must now also hold on the NFS server.
- **runsc is now the load-bearing runtime.** A pinned binary + node
  containerd config in `cluster setup`, a CVE stream to track, and a
  behavior surface to re-verify on upgrades — the Phase 5 probe suite is
  the regression gate. (Mitigating context: a sentry escape lands the
  attacker in an unprivileged host process, still outside the userns-era
  protections' threat model only by degree — but kube-system and the
  host remain runc/kernel-hardened as today.)
- **NFS server availability.** The export is a SPOF for all shared
  project state; needs a snapshot/backup story from day one (same class
  of risk the JuiceFS meta engine carried; NFS just makes it one boring
  daemon instead of Redis + object store).
- **Unix sockets on the shared FS** rendezvous node-locally only — fine
  under the Phase 4 split (tmux stays node-local), but nothing shared may
  assume cross-node socket connectivity.
- **tmux is already multi-node-clean (verified).** Every consumer reaches
  the socket at its in-container path via `kubectl exec` — interactive
  attach (`pty-bridge.ts` builds `kubectl exec -it job/<n> -- tmux -S … attach`),
  the status watcher's persistent `tmux -C` control-mode stream, and the
  liveness probe (`cleanup.ts` runs `tmux has-session` via exec, not the
  host socket file). The K8s exec API is the cross-node transport
  (apiserver → kubelet), so no change is needed. The hostPath mount
  (`sessions/<sid>/tmux`, socket + pane log) has no host-side reader of the
  socket; keep it node-local per Phase 4, and consider demoting it to an
  emptyDir once it's confirmed the pane log needn't outlive the pod.
- **Cleanup paths** (`cleanup.ts` `rm -rf`, orphan GC) touch both roots
  after Phase 4; the GC sweep must enumerate node-local roots per node
  (or move session-dir cleanup into the pod/node).
