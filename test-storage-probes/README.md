# Storage probes

The go/no-go probe chain for the shared filesystem in
[docs/plans/multi-node-storage-plan.md](../docs/plans/multi-node-storage-plan.md):
does a network filesystem behave correctly, coherently, and fast enough under
gVisor to hold per-project session state across nodes?

These are standalone scripts, not part of `pnpm test`. They need a running
cluster and they create and destroy real pods, mounts, and an NFS export.

```
test-storage-probes/setup-nfs-export.sh     # stand up the backend
test-storage-probes/run-all.sh              # pods -> semantics -> locks ->
                                            # coherence -> perf -> RWX
test-storage-probes/teardown-nfs-export.sh  # remove all of it
```

`run-all.sh` takes a stage name (`pods`, `semantics`, `locks`, `coherence`,
`perf`, `rwx`) to run one arm at a time. Settings come from the environment —
`SHARED_MNT`, `BASELINE_DIR`, `PROBE_IMAGE`, `NODE`, `NS` — see `lib.sh`.

## What each probe answers

| Script | Question |
|---|---|
| `fsprobe.py` | Do ownership, O_EXCL, rename, `link(2)`, locks, mmap, xattrs behave? |
| `lockscope.sh` | Does a lock taken in a sandbox reach the server, so another node sees it? |
| `append-race.sh` | Is concurrent O_APPEND from two sandboxes atomic? |
| `coherence.sh` | How stale is a sandbox's view of an externally-written file? |
| `gitprobe.sh` | What do clone/status/checkout/`worktree add`/pnpm-link cost per arm? |
| `hybrid.sh` | Does shared-repo + node-local-worktree recover that cost? |
| `csi-rwx.sh` | Can two gVisor pods share one RWX PVC without losing writes? |

## Reusing this for another backend

Only `setup-nfs-export.sh` is NFS-specific. The probes take a mount path, so
pointing `SHARED_MNT` at a CephFS or JuiceFS mount runs the identical chain —
which is what the plan's fallback section calls for.

## Two traps worth knowing

**A second mount on one host is not a second client.** Mounting the same NFS
export twice with `-o nosharecache` still shares one NFSv4 client identity, so
the kernel trusts its own cache and external namespace changes may never become
visible. That looks like a catastrophic coherence bug and is purely an artifact.
`nfs-writer-pod.yaml` exists to avoid it: it mounts inside its own netns, so it
gets its own `clientaddr`. Check `clientaddr=` in `mount` output before trusting
any coherence number.

**Sandbox-local locks are a gVisor property, not a filesystem one.** The sentry
emulates `fcntl`/`flock` internally, so a lock taken in a pod is invisible
everywhere else — including on plain ext4. `lockscope.sh` includes an
unsandboxed control cell so the two causes stay distinguishable.
