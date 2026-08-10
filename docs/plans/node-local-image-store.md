# Node-local additional image store, reinstated

Goal: bring back a node-local `additionalimagestores` lower for nested
worktrees — a per-(node, project) read-only containers/storage store,
materialized from the project registry and mounted into every nested
worktree pod — so cached images are visible to a fresh worktree's engine
with **zero prime latency and zero graphroot spend**, and concurrent
worktrees on a node share one copy of the layer data.

The registry stays the source of truth (salvage is unchanged); the node
store is a per-node cache of it, so nothing re-ties a worktree to the node
its predecessor ran on — a cold node just behaves like today.

Two known costs, and this plan's stance on them:

1. **Build complexity** — something must materialize a store on each node
   from the registry. Kept small by reusing the prime policy verbatim and
   the trusted-infra-pod pattern the registry's `hosts.toml` writers
   already use (§ Store builder).
2. **`podman image ls` slowness** — the traditional failure mode of
   additional stores, made worse here because the store mount crosses the
   gVisor gofer boundary. This is the bulk of the plan (§ Diagnosis,
   § Mitigations). The punchline: the folklore slowness is mostly a
   *daemonless-podman* artifact plus a metadata gap, and our architecture
   already has the daemon; what remains is making the gofer mount cacheable
   and the one cold walk small and off the critical path.

## Diagnosis: why `image ls` over an additional store is slow

Three independent causes, ranked by how much they cost:

- **Per-invocation store reload.** Daemonless podman constructs a fresh
  containers/storage instance on every CLI call: read `images.json` and
  `layers.json` of every store, stat layer directories, take lockfiles.
  Over a gofer at ~1–2ms/op (the extraction figure measured for
  docs/nested-containers.md), a few thousand ops is seconds — *per
  command*. This is where the horror stories come from.
- **Missing size metadata.** `podman images` shows sizes; when a store's
  `layers.json` lacks recorded diff sizes, libpod recomputes them by
  reading (and decompressing) each layer's `tar-split.gz`. Over gofer this
  is catastrophic; even natively it is the classic "images takes minutes"
  bug.
- **Per-op gofer latency itself.** Every open/stat/read that does reach
  the host filesystem pays a sentry→gofer round trip. runsc's default for
  non-root mounts is `file-access-mounts=shared` — revalidate on every
  access, minimal caching — so even repeated operations keep paying.

## Mitigations

Layered; M1–M5 need no gVisor changes and are the plan of record. M6 is a
parked escalation with hard prerequisites.

- **M1 — one long-lived daemon (already our shape).** The engine is a
  single rootful `podman system service`; both CLIs are remote clients
  (`DOCKER_HOST`/`CONTAINER_HOST`), so `docker image ls` and `podman image
  ls` are answered from the daemon's in-memory store view. c/storage
  loads the additional store **once** and afterwards revalidates by
  statting its lockfile. The per-invocation reload cost — the dominant
  folklore cost — simply does not exist for socket clients. (The salvage
  scripts' `sudo podman` invocations are local engines and do re-walk;
  M3 makes that walk cached, and they are off the interactive path.)
- **M2 — complete metadata at build time.** The store is built by real
  `podman pull` (not hand-assembled), so `layers.json` records
  compressed/uncompressed diff sizes and `images.json` is complete: no
  tar-split reads, ever. A store-build post-check asserts every layer has
  a recorded diff size and fails the publish otherwise.
- **M3 — immutable generations + exclusive sentry caching.** The store is
  published as write-once generation directories; a published generation
  is never mutated (new content ⇒ new dir). That makes it sound to mount
  with the gVisor mount-hint annotations the graphroot already uses
  (`dev.gvisor.spec.mount.<volume>.share: container`, `options: ro`),
  flipping the mount from the revalidating default to **exclusive**
  caching: dentries, attributes, and pages are cached in the sentry, so
  after first touch, metadata ops are sentry-internal. Modern runsc's
  directfs further cuts the cost of the misses that remain.
- **M4 — warm off the critical path.** The postStart engine-start script
  already backgrounds engine bring-up; it gains one `podman image ls
  >/dev/null` against the socket after the socket handover. That pays the
  single cold walk (daemon load + sentry cache fill) before the user runs
  anything. Estimated cold walk for a bounded store (~2 files JSON + a
  few reads/stats per image and layer, low thousands of ops): a couple of
  seconds in the background, once per worktree.
- **M5 — a bounded store.** The builder applies the prime's ranking
  policy (`PRIME_GENERATIONS_KEPT` newest content-hash generations per
  repo, chain slots follow their generation), so the walk that M4 pays is
  over a store sized like today's prime working set, not an unbounded
  archive. Registry retention (`REGISTRY_GENERATIONS_KEPT`) bounds it
  upstream.
- **M6 (parked) — in-sentry EROFS.** Pack each generation into an EROFS
  image; runsc mounts `type: erofs` spec mounts wholly in-sentry (the
  gofer donates one image FD; all metadata and reads are `pread` against
  it). Generation = one file: atomic publish, trivial GC, no gofer on any
  path. Parked because two upstream gaps block it: the mount-hint
  annotation accepts only `tmpfs`/`bind` (`MountHint.setType`), so
  reaching `type: erofs` from a k8s pod needs a small runsc patch or an
  NRI plugin rewriting the OCI spec — and we currently ship the pinned
  upstream runsc release, so a patch means building and hosting our own;
  and gVisor's erofs fsimpl returns `ENOTSUP` for **all** xattr reads,
  which is a correctness hole (below), not just a feature gap. Revisit
  only if M1–M5 measurements miss the gates, and prefer upstreaming both
  pieces over carrying a fork.

## Correctness: xattrs are the hard part, not latency

The tmpfs-primed graphroot holds whatever a layer's tarball says. A store
served across the host↔sentry boundary may not, in two places:

- **File capabilities** (`security.capability`): goferfs refuses *writes*
  to `security.*` (the reason the graphroot is sentry tmpfs); whether
  *reads* pass through, and what an unprivileged gofer can even see, is
  unverified. A cached layer whose binary carries file caps must not
  silently lose them.
- **Overlay opaque-directory markers**: a layer that replaces a directory
  records it as an xattr on the diff dir — `trusted.overlay.opaque`
  (rootful shape) or `user.overlay.opaque` (userxattr shape). An
  **unprivileged gofer cannot read `trusted.*` at all** (host
  `CAP_SYS_ADMIN`), so a store written in rootful shape would quietly
  resurrect deleted files when the sentry's overlay merges lowerdirs.
  The userxattr shape is gofer-readable, but the sentry overlay must then
  honor `userxattr` semantics for lowers. (Plain whiteouts are 0:0 char
  devices — metadata, expected to pass through gofer fine.)

So the builder must write the store in a shape the sentry can actually
read back, and the spike below decides which shape that is. Fallback if
neither xattr shape survives the boundary: a store-build post-pass that
rewrites each opaque marker into explicit per-entry whiteouts computed
against the layer's own (fixed) parent chain — semantically equivalent
for a completed image, no xattrs needed — plus an explicit decision on
file caps (measure how often project images carry them; if rare, degrade
with a build-log warning rather than block).

**Spike 0 (gate for the whole plan).** One fixture image exercising all
three encodings — a setcap'd binary, an `rm -rf`'d-and-recreated
directory, a deleted file — pushed through salvage → builder → store →
fresh worktree. Assertions in the consuming worktree: `getcap` shows the
caps, the recreated directory does not resurrect pre-wipe entries, the
deleted file is absent, `podman image ls` sizes are sane, and a `docker
build` FROM the cached image cache-hits. Run it per candidate store shape
(rootful vs userxattr) and let the winner set the builder's storage
options.

## Store builder

A trusted node-side pod per project — same infra tier as the registry and
proxy (runc, plain root, no sandbox: it is our code touching our node
path), image `quay.io/podman/stable` (already digest-pinned and mirrored
for the trust-split builder pods) — with the store parent hostPath-mounted
rw:

- Store layout: `<data dir>/shared-images/<project>/gen-<stamp>/`, a
  complete overlay store (`podman pull --root <gen dir>`).
- **Seed by hardlink**: `cp -al` the previous generation, then pull the
  delta. Pull only adds layer dirs and rewrites the JSON metadata files
  via temp+rename, which safely breaks the hardlink — so a generation
  costs disk proportional to what changed. (Spike 1 confirms c/storage
  never mutates a layer diff in place on this path.)
- **Policy is the prime's, verbatim**: walk the registry catalog, rank
  content-hash generations newest-first by image-config build time, keep
  `PRIME_GENERATIONS_KEPT`, restore salvaged names, untag `yaac-cache-`
  chain slots into dangling cache entries. `buildPrimeScript` retargets
  from the engine socket to `--root`; the ranking logic is shared, not
  forked.
- **Publish** = the server observing a completed generation dir (a DONE
  marker written last). No symlink flip: the server mounts the newest
  complete generation *path* into each new pod, so a pod's store is
  pinned for its lifetime and mounts never change under a running
  worktree ("attach" happens at pod create; running worktrees pick up new
  generations only on recreate).
- **Triggers**: after a salvage push that actually pushed something, and
  a reconcile step on server start; throttled per project like the
  registry collect. **GC**: delete generations that are not the newest
  complete one and are referenced by no live pod's mounts (the server
  knows, it wrote the mounts), and drop the whole store dir on project
  removal.
- Single-node today means one builder run per project; the layout and
  trigger are keyed by (node, project) so multi-node is additive — run
  the ensure per node that hosts the project's worktrees, which is the
  same shape the multi-node storage plan already assumes for node-local
  caches.

## Wiring changes

- `dockerfiles/Dockerfile.nestable`: `storage.conf` gains
  `additionalimagestores = ["/var/lib/shared-images"]` (and the "there is
  NO additionalimagestores lower" comment block goes away). A missing or
  empty mount is harmless — podman treats an absent additional store as
  empty — so non-nested pods and cold nodes need no special casing.
  Flip the two assertions that pin its absence
  (`dockerfiles.test.ts`, `test/e2e-cli/nested-containers.test.ts`) and
  restore a cross-worktree cache-sharing e2e.
- `pod-spec.ts`: a `shared-images` volume (hostPath to the pinned
  generation dir, readOnly) plus a `sharedImagesMountAnnotations()`
  sibling of `graphrootMountAnnotations()` — `share: container`,
  `options: ro`. Nested worktrees only; inner-yaac worktrees stay
  uncached (their vcluster's VAP denies the hostPath), unchanged.
- `#runtime/k8s/images`: a new `store-builder.ts` module behind the
  barrel (it needs the cluster, so it lives in the cluster-side half),
  owning ensure/GC; worktree create calls the ensure where it already
  ensures the registry.
- `primeWorktreeImages` is deleted along with its half-full budget: the
  graphroot's 12GiB is once again entirely the worktree's own build
  space. Salvage, registry GC, and retention are untouched.
- docs: fold the shipped result into docs/nested-containers.md (the
  "registry is the only distribution mechanism" paragraph changes) and
  delete this plan.

## Phases and gates

1. **Spike 0** (xattr fidelity, above) and **Spike 1**: mount a
   hand-built store ro with the `share=container` hint into a nested
   worktree; verify the hint applies to hostPath volumes, `getcap` /
   opaque behavior per shape, hardlinked generations, and that a ro store
   with pre-created lockfiles satisfies c/storage.
2. **Builder + wiring** behind a config flag, prime still in place.
3. **Measure** on a realistic store (the yaac chain plus a
   node_modules-heavy project image set): warm `podman image ls` and
   `docker image ls` < 150ms; user-visible cold `ls` (i.e. after the M4
   background warm) < 1s; full-cache-hit `docker build` and first
   `docker run` of a cached image within ~1.5× of the tmpfs-primed
   baseline. Miss ⇒ un-park M6 before shipping.
4. **Cut over**: delete prime, flip the e2e assertions, update docs.

## Open questions

- First-touch reads of shared lowerdirs (a `COPY` from, or process exec
  out of, a big cached layer) pay per-file gofer cost once per pod even
  under M3. The measurements in phase 3 decide whether that is acceptable
  or an M6 forcing function.
- Whether `docker rmi`/`podman rmi` of a store-provided image inside a
  worktree degrades gracefully (it cannot delete from a ro store; it must
  error or hide, not wedge the engine).
- Whether the builder should also pre-pull the worktree's *own* chain
  image (base/tools/nestable) into the store so `docker build` of
  `Dockerfile.yaac`-derived images cache-hits the yaac chain too — free
  under the same policy if those repos pass the generation guard.
