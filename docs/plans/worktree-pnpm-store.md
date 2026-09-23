# Per-worktree pnpm store behind a cluster-wide Verdaccio

Under `k8s`, give every worktree pod its own pnpm store, held with its
`node_modules` in one pod-local emptyDir, and point it at a single
Verdaccio registry cache that serves the whole cluster. This replaces the per-project store that every
worktree shares today. `containerless` stays as it is.

## Why

**The shared store corrupts.** pnpm 11 keeps the store's index in one
SQLite database, `<store>/index.db`, in WAL mode. WAL needs every process
using the database to share memory (the `-shm` file) and file locks, so
SQLite supports it only when all of them run on one host
([sqlite.org/wal.html](https://www.sqlite.org/wal.html)). Every worktree pod
is its own gVisor sandbox with its own sentry kernel, and the store reaches
each one over a 9p mount of the same node directory. Each sandbox keeps its
locks to itself, so worktrees that install at the same moment write the
database with no coordination at all. Three worktrees starting within five
minutes of each other were enough to corrupt it. A write then fails with
`database disk image is malformed`, and a read of a torn entry fails with
`ERR_PNPM_READ_FROM_STORE ... end of buffer not reached`. Every later
`pnpm install` in the project fails until someone moves `index.db` aside by
hand. Before pnpm 11 the index was one file per package, which is why this
store only started breaking after the 11.1.2 upgrade.

**It also doesn't save disk.** The seed and create code say the store sits
under `.cached-packages` so that `node_modules` can hardlink into it. But
the store and each ephemeral-modules slot are separate mounts, and a
hardlink can't cross mounts (`ln` from the store into
`/workspace/node_modules` fails with `Invalid cross-device link`). pnpm
copies every file instead: files in a worktree's `node_modules` have a link
count of 1. Each worktree already holds a full copy of its dependencies. The
shared store only saves downloads.

**The replacement is about as fast.** Timed full installs of this repo
(856 packages, no build scripts), each starting from an empty store and an
empty `node_modules`:

| Store and `node_modules` on | Packages from | Time |
|---|---|---|
| sandbox-internal disk | warm Verdaccio | 10.4s |
| sandbox-internal disk | registry.npmjs.org | 12.3s |
| 9p host mount | warm Verdaccio | 14.6s |
| sandbox-internal disk, store already full | — | 5.3s |

A worktree start pays about five seconds more than a warm shared store would
give it, and can no longer corrupt anything. Verdaccio saves little over
npmjs on a fast link. What it adds is installs that keep working when npmjs
is slow, rate-limiting, or down, and far fewer fetches from the internet as
the number of worktrees grows.

## Design

### Verdaccio, one per install

- Built the way the main registry is (`main-registry.ts`): a Deployment in
  the install namespace (`app: yaac-npm-cache`) with `replicas: 1` and
  `strategy: Recreate`, a ClusterIP Service, and an RWO PVC keyed by
  install that names no `storageClassName`. Every worktree on every node
  shares one warm cache, so a package is fetched from npmjs once per
  cluster, not once per node.
- **One writer.** Verdaccio's storage is plain files, safe for one process
  and not for several. `Recreate` means the old pod is gone before the new
  one mounts the claim, so a rollout never has two writers, and RWO holds
  the claim to one node at a time.
- **The cache belongs to the claim, not to a node.** Nodes are disposable
  (docs/plans/cloud-k8s.md "Decisions"), and a pod rescheduled elsewhere
  reattaches the same claim warm. A lost claim costs a cold cache and
  nothing else, since everything in it can be fetched again.
- **Read-only to worktrees.** `publish` and `unpublish` are `$nobody` for
  every package pattern. Every worktree of every project shares this
  cache, and a worktree that could publish could poison what other projects
  install. What worktrees can pull is still bounded by the lockfile: pnpm
  checks every tarball against the lockfile's integrity hash, whoever served
  it.
- Only the public npm registry as the upstream. The worktree env sets just
  the default registry (`pnpm_config_registry`), so a project `.npmrc`
  sending a scope to a private registry (`@scope:registry=…`) still wins,
  and those requests keep going direct through the egress proxy with their
  credentials.
- The image is mirrored into the local registry by digest, like
  `registry:2` and the envoy image (`test/global-setup.ts` gets the same
  mirror for the e2e tiers).

### Network

- **Worktree → Verdaccio.** A worktree pod reaches the Service by its
  `*.svc` name through the proxy's split-horizon DNS, on 4873 — not a
  redirected port, so netd leaves it alone. The pod may be on another
  node; on kind there is only one. The worktree NetworkPolicy
  gains one allow rule for `podSelector: app=yaac-npm-cache` on tcp/4873,
  next to the existing rule that admits the proxy.
- **Verdaccio → npmjs.** Verdaccio isn't a worktree pod, so netd never
  redirects it. It needs its own egress allow to 443, and the ingress wall
  admits only worktree pods of this install.

### The worktree pod

- **One emptyDir, `pnpm-modules`**, replacing the `hostPath` slots under
  `.cached-packages/modules/<worktreeId>/<slot>`. It carries the same gVisor
  mount-hint annotations the nested graphroot uses (`type: bind`,
  `share: container`, `size=`), which make it a sentry-internal tmpfs paged
  against a filestore in the emptyDir: node disk, not pinned memory, and not
  proxied through the gofer. That is the sandbox-internal row of the table
  above. `graphrootMountAnnotations` generalizes to take the volume name.
- **The store goes inside the root `node_modules` mount:**
  `pnpm_config_store_dir=/workspace/node_modules/.pnpm-store`. Same mount,
  so pnpm hardlinks. pnpm itself falls back to this location when nothing
  above the project accepts a hardlink. Only the root `node_modules` holds
  real files: pnpm's virtual store, `.pnpm`. Nested `ephemeralModulesPaths`
  such as `packages/web/node_modules` hold only symlinks into it, so they
  can be other mounts of the same volume.
- `pnpm_config_registry` points at the Verdaccio Service.
  `npm_config_store_dir` is dropped from the k8s env: the image pins pnpm
  11, which reads only `pnpm_config_`. The env overrides the image's own
  `pnpm config set store-dir` (`Dockerfile.default`), which stays for
  whatever runs pnpm in the image without the worktree env.
- **Storage accounting.** Today the modules are hostPath, which kubelet
  doesn't count as ephemeral storage; an emptyDir is counted. The pod's
  ephemeral-storage request and limit, and the emptyDir's `sizeLimit` above
  the sentry `size=` cap, grow by the modules budget. Same slack reasoning
  as `NESTED_GRAPHROOT_SIZELIMIT_BYTES`: a runaway install should hit ENOSPC
  inside the pod, not get the whole worktree evicted.
- **Lifetime.** The emptyDir goes away with the pod. A worktree Job is
  `backoffLimit: 0` / `restartPolicy: Never`, so there are no in-pod
  restarts to survive, and a stop already throws `node_modules` away: the
  restart's init commands reinstall. Nothing about a stopped or restarted
  worktree changes, except that the reinstall pulls from Verdaccio.

### What stays

- **`containerless` keeps the shared project store.** All of its worktrees
  are processes on one host, where WAL is supported, and its
  `node_modules` stay in the checkout.
- **The `.cached-packages` mount stays** in k8s pods. It's documented as the
  place for other package managers' caches (README "cacheVolumes"). Only
  pnpm stops using it on k8s.

## What goes away

On k8s the ephemeral-modules backing dirs stop existing, and so does the
code that makes and removes them:

- `prepareEphemeralMounts` stops producing a `hostBacking`. The modules
  dirs then drop out of `nodeLocalDirsOf`, and with them the init
  container's work for them. `mkdirMountTarget` stays: the mount target is
  still a directory in the checkout.
- `cleanup.ts`: `worktreeModulesDir` and its removal at stop and teardown.
  `checkoutEphemeralPaths` stays for containerless and for the empty mount
  placeholders.
- The "hardlink affinity" comments in `seed.ts` and `create.ts`, which
  describe something that doesn't happen.

Two sweeps become legacy-compat shims, because installs that ran before
this change still hold `modules/<id>` dirs and a pnpm-11 store under
`.cached-packages`:

- `orphan-modules-gc` (reconcile) and the `.cached-packages/modules` arm of
  the node-local sweep. They already delete exactly the dirs this change
  stops creating, so they stay as they are and get a
  `docs/legacy-compat-shims.md` entry. **Reads:**
  `<nodeLocal>/projects/<slug>/.cached-packages/modules/*`. **Breaks
  silently if deleted too early:** old worktrees' copies of `node_modules`
  (a full copy each, given the missing hardlinks) stay on node disk
  forever. **Safe to remove:** once no node has a `modules/` dir left.
- The old shared store, `.cached-packages/pnpm-store/v11`, becomes dead
  weight on k8s nodes (1.2 GB for this project). Either the node-local
  sweep deletes it once per project (a new shim entry), or the release
  notes say to remove it by hand. The sweep is the better option: nobody
  will remember to.

## Work, in order

1. **Prove the pod half on the cluster, without Verdaccio.** Put the
   emptyDir with mount hints and the in-mount store into the pod spec, then
   measure `pnpm install` from npmjs in a real worktree. Check the three
   things this plan assumes and that no single-sandbox benchmark can show:
   - The mount hint applies to an emptyDir mounted at more than one path
     (subPath per ephemeral slot). If it doesn't, give each slot its own
     emptyDir; only the root slot needs the store.
   - pnpm hardlinks inside the sentry tmpfs (a link count of 2 in
     `node_modules/.pnpm`).
   - kubelet reclaims the emptyDir when a stopped worktree's Job is deleted,
     and a finished pod that lingers doesn't hold on to the space.
2. **Verdaccio Deployment, claim, Service, and policies** from `yaac cluster
   install`, with a `yaac cluster check` probe: a worktree-labelled pod
   fetches a tarball through the Service. The worktree env sets the registry
   only when the install has the cache, so a cluster installed before this
   step keeps pulling from npmjs until it is reinstalled.
3. **Delete** the k8s modules backing path, add the shim entries, and fix
   the comments. `docs/worktree-storage.md` gets the new layout, and this
   plan is deleted.

## Tests

- `unit:server`: the pod spec renders the `pnpm-modules` emptyDir, its
  mount-hint annotations, one mount per ephemeral path, and no `node-root`
  modules init entries; the worktree env carries the in-mount store dir and
  the registry.
- e2e (host-only; needs a cluster): a worktree whose init command runs
  `pnpm install` installs from Verdaccio (its log records the fetch), with
  hardlinked `node_modules`. A second worktree of the same project installs
  while the first is installing, and both succeed; that race is what
  corrupted the shared store. Both cases share one worktree fixture per
  file.
- `cluster check`'s new probe runs in the install e2e tier like the other
  probes.

## Open questions

- One replica is a single point of failure for installs: while its pod is
  down (a rollout, or a node drain waiting for the claim to reattach),
  every worktree start that runs `pnpm install` fails. The main registry
  already has the same exposure for image pulls, so that is accepted for
  now. If it bites, the fix is a fallback registry in the worktree env,
  not more replicas, which would bring back several writers.
- On a multi-node cloud cluster, installs cross nodes to reach the cache.
  Measure that in step 7 of docs/plans/cloud-k8s.md.
- `pnpm add` in a worktree resolves new versions through Verdaccio, which
  has to pass the upstream packument's `time` field through for
  `minimumReleaseAge` to keep working. Verdaccio proxies it, but confirm it
  on the cluster before relying on it.
