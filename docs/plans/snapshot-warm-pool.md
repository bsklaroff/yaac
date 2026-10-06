# Memory-snapshot warm pool

**Blocked on upstream: do not implement until
[KEP-5823](https://github.com/kubernetes/enhancements/issues/5823)
(pod-level checkpoint/restore) ships at least alpha in a Kubernetes release
we can run on kind and EKS.** The KEP owns the hard part, which is getting
kubelet and the runtime to create a pod *as a restore* of a checkpoint.
Building that ourselves would mean driving `runsc` behind the kubelet's back,
and that work would be thrown away once the KEP lands. The prep in
"Before the KEP" below is allowed, because it pays off with or without
snapshots.

## Goal

A prewarmed spare (`domain/workspaces/prewarm.ts`, `spare-pool.ts`) is a
fully booted workspace pod with its agent running, so every spare costs the
RAM and CPU of a live workspace. A pool of memory snapshots would cost disk
instead. A claim restores the snapshot into a new pod with the agent already
loaded, and skips the cold path's image pull, init, and agent launch.

The win is cost, not latency. A claimed live spare is faster than any
restore, which adds seconds of kernel-state load plus reconnects. Snapshots
make sense once spare RAM, not claim time, is what limits pool size.

## Upstream state (checked 2026-10)

- **KEP-5823** adds a `PodCheckpoint` object and a pod field
  `spec.restoreFrom`, behind the `PodLevelCheckpointRestore` gate. It is
  meant to work regardless of runtime and names gVisor alongside CRIU.
  Checkpoints stay on the node that took them. Restoring on another node,
  keeping the pod's IP, and keeping TCP connections are all out of scope.
  Alpha is targeted for v1.38; the implementation is
  kubernetes/kubernetes#140186, which is open and on hold.
- **kubernetes-sigs/agent-sandbox** (v1.0.x): `SandboxWarmPool` keeps
  running pods. Its suspend/resume deletes the pod and keeps the PVCs, so
  memory is lost. Memory snapshots exist only as a client wrapper over
  GKE Pod Snapshots (`examples/podsnapshot-golden-warmpool`). The portable
  snapshot-provider proposal (#694, #949) is still open.
- **GKE Pod Snapshots** has shipped gVisor-based restore of an identical
  pod spec, but it is GKE-only and not something we can run on kind.
- **gVisor**: `runsc checkpoint` and `runsc restore` work, including
  `--background` restore that resumes the app before all memory is loaded.
  The open-source containerd shim does not implement the standard
  checkpoint call, which is why KEP-2008's forensic checkpointing does not
  work with gVisor and why there is no open-source restore path today.

## What restore breaks in a workspace

- **Pod identity in the spec.** A restore reuses one checkpoint for many
  pods, so the spec cannot carry any one workspace's identity. Today it
  carries the workspace id, the `agent/<id>` branch, the stream token, the
  time zone, git identity, the npm registry, and per-workspace subPath
  mounts of `yaac-global`. All of these must be handed to the pod at claim
  time instead.
- **The checkout is outside the snapshot.** Volumes are not captured, so a
  restored agent wakes up expecting a checkout that the claim has to put
  in place before the process resumes.
- **Connections reset.** The pod comes back with a new IP, and its
  connected sockets get ECONNRESET. That covers streamd's links to the
  server, the tmux control stream, acpd's clients, and each agent's open
  HTTPS connections through the proxy. Host unix sockets
  (`host-uds=all`) probably do not survive at all. Egress identity is
  already safe: a claim re-registers the workspace with the proxy
  (`registerWorkspace`), and netd applies its rules to each new pod.
- **Matching.** A restore needs the same gVisor version, runsc flags, CPU
  features, and kernel as the checkpoint, so snapshots are invalidated by
  every gVisor bump and every image change, much like image content hashes
  are today.

## Before the KEP

These are worth doing on their own and shrink the later change:

- **Move per-workspace identity out of the pod spec**, into something
  delivered at claim time (a file `yaac-workspace-init` reads, or a streamd
  call). This also simplifies `rebranchSpare` and `retoolSpare`.
- **Spike, measuring only, on a host kind cluster.** Run `runsc checkpoint`
  against a live spare and restore it by hand. Record the snapshot size,
  the restore time with and without `--background`, and whether claude,
  codex, opencode, pi and acpd each recover from the connection reset. If
  an agent cannot recover, this plan needs a re-launch step after restore,
  and most of the benefit goes away.

## After the KEP

- Replace each project's spares with one checkpoint per (project image,
  mode) taken from a primed spare. Keep at most one live spare, or none.
- A claim creates the workspace pod with `spec.restoreFrom`, puts the
  checkout in place, then delivers the identity and the prompt.
- If a restore fails or no checkpoint matches, fall back to the cold path,
  just as a claim that finds no spare does today.
- Checkpoints are local to a node, so on multi-node clusters the pool is
  per node and needs node affinity on restore.
- Retake checkpoints when the image hash or gVisor version changes, and
  garbage-collect them alongside images (`docs/image-gc.md`).

## Open questions

- Does KEP-5823's restore work with our runsc RuntimeClass on the pinned
  gVisor version, or does gVisor need shim support first?
- How large is a checkpoint with an idle agent, and does node disk or
  restore I/O become the new limit?
- Should the snapshot be taken before the agent launches (smaller, simpler
  identity handover, slower claim) or after?
