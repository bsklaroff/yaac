# Multi-node storage plan: shared project data across nodes

Goal: move yaac from the single-node kind cluster toward a multi-node
cluster where session pods of one project can run on different nodes while
sharing per-project state (`claude/`, `repo/.git`, caches) as if they were
on the same node — without giving up `hostUsers: false`.

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

## The gating constraint: idmapped mounts

Session pods run `hostUsers: false` (user namespaces). The kubelet/runtime
applies an idmapped mount (`mount_setattr`) to **every** pod volume, so the
filesystem backing each volume must support idmapped mounts or the pod
fails to start (`mount_setattr … Invalid argument`). Dropping
`hostUsers: false` is not on the table (it is the containment layer for
in-container root/sudo).

Idmap support by filesystem (as of kernel 7.0 / K8s 1.36 GA docs):

| Filesystem | Idmapped mounts | Notes |
|---|---|---|
| ext4 / xfs / btrfs / tmpfs / overlayfs | ✓ (≥5.12–6.3) | why today's setup works |
| CephFS kernel client | ✓ (≥6.7) | needs Reef+ MDS (`CEPHFS_FEATURE_HAS_OWNER_UIDGID`); `enable_unsafe_idmap` for older MDS |
| FUSE | ✓ kernel-side (≥6.12) | **daemon must opt in**: `FUSE_ALLOW_IDMAP` + `FUSE_OWNER_UID_GID_EXT` init flags + `default_permissions` |
| NFS client | ✗ | the K8s docs' "notable absence"; no sign of it landing |

Consequence: plain NFS is dead for pod-visible storage. The constraint
applies only to *pod volume mounts* — the server (host process, no userns)
may use NFS freely.

## Options considered

| Option | Verdict |
|---|---|
| NFS shared `<dataDir>` | ✗ pod mounts fail under userns; hard kernel limitation |
| Direct S3-FUSE mappers (s3fs, goofys, GeeseFS, Mountpoint-S3, rclone mount) | ✗ regardless of idmap: no/fake hardlinks, renames, locks — git/pnpm/SQLite can't run |
| Per-session local disk + explicit data plane (kopia checkpoint/restore to object store, Litestream for SQLite, transcript shipping over WS) | ✓ works, no shared FS at all — but the most app code: server-decoupling refactor, checkpoint semantics, consistency discipline. Fallback if all shared-FS options fail. |
| Project→node affinity (each project pinned to a home node; pods share via local ext4; server reaches nodes over NFS, which is legal server-side) | ✓ zero new storage tech in the pod path; caps a project's sessions to one node. Good stopgap and load-spreading model. |
| CephFS via Rook | ✓ proven idmap-capable RWX; architecture unchanged (shared mount at same path everywhere). Cost: operating Ceph (operator + mons + MDS). Fallback #1. |
| **JuiceFS (metadata engine + S3 chunks) with idmap patch** | **✓ primary candidate** — full POSIX (hardlinks, flock/fcntl, mmap, atomic rename; pjdfstest-clean), Apache-2.0, S3/SeaweedFS backend. Kernel side ready (FUSE idmap ≥6.12; hosts run 7.0). JuiceFS does not yet set go-fuse's `IDMappedMount`, but the library implements it — the enablement is a small patch (see spike). |

Why JuiceFS over CephFS as first choice: same architectural outcome (one
POSIX mount at `<dataDir>` on every node + the server host, zero yaac code
changes), but the moving parts are a metadata engine (e.g. Redis) plus any
S3-compatible store, instead of a Ceph cluster.

## Plan

### Phase 0 — prove the topology (no storage change)

Multi-node kind on one host: all node containers see the same host
filesystem, so extending `extraMounts: $HOME → $HOME` to every node keeps
hostPath + ext4 + idmap working unchanged while exercising real multi-node
scheduling.

- [ ] kind config with 2–3 nodes, `extraMounts` on each.
- [ ] Make the local registry reachable from every node (Service/hosts.toml
      on all nodes, not just control-plane).
- [ ] Audit node-local paths for multi-node behavior:
      `/var/lib/yaac/imagecache/<hash>` and `/var/lib/yaac/registry/<hash>`
      become per-node (acceptable: cold cache on other nodes) — verify
      nothing *breaks*, only warms slower.
- [ ] Run the e2e suite against the multi-node cluster.

### Phase 1 — JuiceFS idmap spike (go/no-go)

- [ ] Patch JuiceFS: expose a mount flag that sets go-fuse
      `MountOptions.IDMappedMount = true` (go-fuse auto-adds
      `default_permissions` and advertises `CAP_ALLOW_IDMAP`); bump the
      pinned go-fuse if needed. Candidate upstream PR.
- [ ] Stand up minimal backing: Redis (meta) + SeaweedFS or MinIO (data);
      `juicefs format` + mount on the host.
- [ ] Probe chain, cheapest first:
      1. `mount -o X-mount.idmap=…` over a JuiceFS path (util-linux issues
         the same `mount_setattr` the runtime does).
      2. `hostUsers: false` pod with a hostPath into the JuiceFS mount;
         verify uid mapping, file creation ownership (`FUSE_OWNER_UID_GID_EXT`
         path: mkdir/mknod/create), locks, hardlinks.
      3. Full yaac session with `claude/` on JuiceFS.
- [ ] Benchmark the hot operations on JuiceFS: `git status`/`git checkout`
      on a real repo, `pnpm install` with store+modules colocated.
- No-go → fall back to CephFS via Rook (re-run the same probe chain; CephFS
  kernel client is known-good for idmap).

### Phase 2 — split shared vs node-local roots

Regardless of which shared FS wins, keep hot per-session dirs off it.

- [ ] `project-paths.ts`: introduce a shared root (default `<dataDir>`) and
      a node-local root; move `worktrees/<sid>`, `sessions/<sid>`, and
      ephemeral modules to node-local; keep `claude/`, `claude.json`,
      `codex/`, `pi/`, `opencode-config/`, `repo/.git`, cache-volumes on
      the shared root.
- [ ] Decide pnpm store placement (hardlink affinity ties the store to the
      modules superblock): recommended **per-node store** (node-local, fast,
      duplicate downloads per node) over store-on-JuiceFS (shared but every
      `link(2)`/stat is a meta RPC).
- [ ] Worktree creation: server currently runs `git worktree add` on its own
      host against `repo/.git`. With repo on the shared mount and worktrees
      node-local, the worktree dir must be created on the session's node —
      either keep worktrees on the shared FS initially (simplest, slower) or
      move worktree creation into an init container (later optimization).
- [ ] PGlite server DB (`<dataDir>/db`): must stay on server-local disk
      (embedded single-writer; never on a network FS). Carve out of the
      shared subtree.
- [ ] opencode per-session SQLite: node-local per Phase 2 split (per-session
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

### Phase 3 — production shape

- [ ] Mount JuiceFS at the shared root on the server host and every node
      (systemd unit / node bootstrap; same absolute path everywhere).
- [ ] Extend `yaac cluster check` with an idmap probe on the shared mount
      (a `hostUsers: false` probe pod writing through a hostPath into it),
      alongside the existing uid-mapping probe.
- [ ] Meta-engine + object-store operations: Redis persistence/backup story
      (`juicefs dump` snapshots), monitoring.
- [ ] Document node onboarding (mount + kubelet prereqs) in
      docs/cluster-setup.md.

## Risks / open questions

- **JuiceFS idmap is unproven end-to-end.** go-fuse implements the
  protocol, but no public report exercises kernel 7.0 + runtime
  `mount_setattr` + JuiceFS. Inode-creation ownership under
  `FUSE_OWNER_UID_GID_EXT` is the likeliest edge. The spike answers this
  cheaply.
- **Why IDMappedMount is opt-in (researched, not a blocker).** The kernel
  makes FUSE idmap conditional on a contract the daemon author must
  affirm: the superblock must use `default_permissions` (kernel does all
  UID/GID permission checks against inode attrs) and the daemon must do
  **no uid/gid-based checks of its own** — with idmap active, requests
  carry mapped ids on inode-creating ops and `-1` elsewhere, so any
  daemon logic keyed on caller uid silently misbehaves. Libraries
  (go-fuse) and filesystems can't flip this by default without changing
  permission semantics for existing users. Consequence for the spike:
  mount JuiceFS **without** daemon-side permission features — no
  `--enable-acl`, no root-squash/all-squash/uid-remap options — so the
  kernel-checks-everything contract holds. Verify chown/chmod and
  mode-bit enforcement behave under the flag; treat JuiceFS ACL support
  as incompatible with idmap until proven otherwise.
- **Metadata latency** on shared-mount git operations; Phase 2's split
  keeps the hot path local, but `repo/.git` object reads during
  fetch/checkout cross the meta engine. Benchmark in Phase 1.
- **Meta engine availability**: Redis becomes a single point of failure for
  all shared project state; needs persistence + backups from day one.
- **Unix sockets on JuiceFS** rendezvous node-locally only — fine under the
  Phase 2 split (tmux stays node-local), but nothing shared may assume
  cross-node socket connectivity.
- **tmux is already multi-node-clean (verified).** Every consumer reaches
  the socket at its in-container path via `kubectl exec` — interactive
  attach (`pty-bridge.ts` builds `kubectl exec -it job/<n> -- tmux -S … attach`),
  the status watcher's persistent `tmux -C` control-mode stream, and the
  liveness probe (`cleanup.ts` runs `tmux has-session` via exec, not the
  host socket file). The K8s exec API is the cross-node transport
  (apiserver → kubelet), so no change is needed. The hostPath mount
  (`sessions/<sid>/tmux`, socket + pane log) has no host-side reader of the
  socket; keep it node-local per Phase 2, and consider demoting it to an
  emptyDir once it's confirmed the pane log needn't outlive the pod.
- **Cleanup paths** (`cleanup.ts` `rm -rf`, orphan GC) touch both roots
  after Phase 2; the GC sweep must enumerate node-local roots per node
  (or move session-dir cleanup into the pod/node).
