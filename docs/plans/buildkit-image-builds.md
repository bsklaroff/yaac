# BuildKit image builds, per-project images and build history

A proposal to replace podman with BuildKit in the gVisor builder pods
(docs/trust-split-builds.md), route build traffic through the egress proxy,
and let a project keep several named images with revision history and a
persistent build list.

## Goals

1. BuildKit builds untrusted layers, wholly inside a gVisor pod, with each
   `RUN` step in a container of its own inside that sandbox.
2. The daemon reads and writes the layer cache with a grant `RUN` steps are
   not handed.
3. A build reads only its own project's cache.
4. Build traffic goes through the egress proxy, under the project's
   allowlist.
5. A project keeps several named Dockerfiles ("images"). A workspace create
   chooses one.
6. Images have revision history, and builds have a persistent, navigable
   record instead of an in-memory list of 30.

Out of scope, kept as follow-ups (see the last section): repos as build
sources (docs/plans/build-repo-sources.md), credentials in builds, a warm
per-project cache.

What does not change: the trusted chain (`base`, `tools`) is still built
by `yaac cluster install` with host podman and only looked up by the
server; content-hash tags still decide whether a build is needed; builder
pods still run under the `gvisor` RuntimeClass, which the admission guard
still requires; the containerless driver still answers `NOT_SUPPORTED`.

This plan assumes nested containers are gone (the in-workspace engine, the
`nestable` layer, the per-project registries and node image stores), which
is separate work. So an image has one chain (`base`, `tools`, its own
layer, the owner's user layer) and one tag per build, and these builder
pods are the only place in the cluster that builds an image.

## Why the daemon is inside the sandbox

Services that build untrusted Dockerfiles put the **whole daemon** inside
the isolation boundary, one per tenant or per build, and treat the daemon
itself as untrusted: a VM or microVM per build (GitHub Actions, Google
Cloud Build, AWS CodeBuild, Fly's builders, Depot, Docker Build Cloud), or
on Kubernetes a VM-backed RuntimeClass such as Kata. Where no VM is
available the choices are rootless BuildKit or a daemonless builder
(kaniko, buildah) in an unprivileged pod, sometimes under gVisor.
Credentials are kept safe by scope and lifetime, not by hiding them from
the build: a short-lived token that can write only the tenant's own repos,
which is what a registry grant already is.

The other arrangement, a trusted daemon outside gVisor with each `RUN` step
in its own runsc sandbox, would hide the grant from `RUN` steps completely.
It is not used here for two reasons. It leaves the daemon's Dockerfile
parsing, context unpacking and layer extraction, all of untrusted input,
running with node-level privilege. And BuildKit's runtime option
(`[worker.oci] binary`) is not a drop-in for runsc: BuildKit passes
`run --keep`, which runsc does not define, runsc's default rootfs overlay
hides a step's writes from BuildKit's snapshot, and its global flags would
need a wrapper. Nobody has publicly reported that combination working.

## Phase 0: spike

A throwaway builder image and a script that drives it by hand on a real
cluster, on a host (a dev workspace has no cluster). yaac has measured
BuildKit under runsc once, about 12 s per build faster than podman, with a
runc 1.1 pin; the spike repeats that on the current gVisor and settles the
details. Pass criteria:

1. A multi-step Dockerfile builds on `tools` and pushes from a pod with the
   capabilities builder pods have today. Which runc the current gVisor
   needs is recorded as a pin.
2. A snapshotter that works on the sentry tmpfs: native overlay, as podman
   uses today, or BuildKit's `native` one.
3. `RUN` steps share the pod's network (`--oci-worker-net=host`), which
   needs no bridge or veth inside the sandbox, and the build's log reaches
   the client intact (buildah's OCI isolation loses output under gVisor,
   which is why podman builds in a chroot today).
4. A `RUN` step cannot read the daemon container's files, its grant
   included, from inside its own container.
5. Registry cache export and the image push each produce a single tagged
   image manifest, never an index (the main registry's collect deletes
   untagged manifests; docs/trust-split-builds.md).
6. Timing: a cold `Dockerfile.yaac` build and a one-step edit, against
   today's numbers.
7. A `SHELL` set in a parent image applies to the `RUN` steps of a
   Dockerfile built on it, and the trusted chain can carry one: `podman
   build --format docker` with the zstd push, or failing that the trusted
   chain built with BuildKit too ("Standard Dockerfiles").
8. The frontend's check mode runs through `buildctl` and reports warnings
   with line numbers.
9. The normalize step: `sudo` works in a `RUN` step, and scanning the
   whole image for files `yaac` owns takes seconds, not minutes.

If BuildKit cannot be made to work under the current gVisor, the builder
keeps podman, and everything in this plan outside "Builder design" still
applies.

## Builder design

### Topology

One daemon pod per build. Projects then share nothing but the registry,
nothing sits idle, and today's pod-per-build shape carries over: the
coordinator, lease, deadline and leak sweep. A cold build pulls its parent,
as it does today.

A daemon shared between projects cannot meet goals 3 and 4. BuildKit can
namespace cache *mounts* (`BUILDKIT_CACHE_MOUNT_NS`) but not its
instruction cache, which is keyed by content and shared by every build on
the daemon; and every `RUN` step would leave from one pod address, so the
proxy could not apply a per-project allowlist.

### Concurrency

At most two builds run at once, across the install, so a yaac upgrade or a
save in ten projects does not start ten builder pods. The rest wait as
`queued`, shown as such, and a build a create is waiting on goes ahead of
the sweep's. The number is an install setting: Settings, or
`yaac config build-concurrency [n]`.

### The builder image

`yaac-buildkit:<hash>`, built by `yaac cluster install` like the other
shipped images: `moby/buildkit` pinned by digest, the runc the spike pins,
and `buildkitd.toml`. Builder pods pull it by recorded digest.

With this and nested containers gone, nothing in the cluster runs podman as
an engine. The mirrored podman image is left as the root utility image of
the node sweeps, root removals and the `node-dirs` init container, none of
which needs podman, so it can be swapped for a smaller one.

### The pod

Today's builder pod with a different engine: the `gvisor` RuntimeClass, the
same capabilities, no service account token, the memory limit and
deadline, and BuildKit's state on the sentry tmpfs the graphroot uses now.
The capability list and tmpfs helpers it shares with nested workspaces
today become the builder's own.
It gains the labels `yaac.project-id` and `yaac.build-id`.

`buildkitd` listens on a unix socket in its own container's filesystem,
which a `RUN` step's container does not see. The server drives it with
`kubectl exec … buildctl`, the pattern the builder uses today.

### One build

For each untrusted layer, the server:

1. streams the context tar in and writes the registry grant as a
   `DOCKER_CONFIG` in the daemon's container (over stdin, as today);
2. runs one `buildctl build` that does what today's pull, build and push
   steps do:
   - `BASE_IMAGE` is the parent's full registry ref, so BuildKit pulls it
     lazily and only if a step has to run;
   - `--import-cache` and `--export-cache type=registry,mode=max` name the
     image's own cache ref (below);
   - `--output type=image,push=true,compression=zstd`, with no
     attestations, so the result is one manifest;
   - `--source-policy-file` (below);
   - `--progress=rawjson`, which the server turns into per-step status and
     logs.

Before that build, the same pod runs the Dockerfile frontend's check mode
over the Dockerfile, which executes nothing. Its warnings are stored on the
build, and an error fails it before any step runs.

### Isolation between projects

**Writes are refused outside the pod.** The grant a build is handed names
its project's image repos and cache repo, and the registry's gate refuses
any other write. Nothing inside the sandbox, the daemon included, can
change that, so one project cannot poison another's cache or images.

**Reads are refused too, for every caller that is a pod.** Today every
`GET` is anonymous, so a `RUN` step can list the registry's repos and
download another project's images. The gate gets a second port, and the
registry's ingress policy sorts callers between the two:

| Port | Admitted by policy | Reads |
|---|---|---|
| node port (today's) | node addresses: containerd, the kubelet probe, a host `port-forward` | anonymous, as today |
| pod port | builder pods and the server | a project, user or cache repo needs a grant naming it; the catalog is refused; the trusted chain and mirrors stay anonymous |

- Workspace pods are admitted to neither port, as today, and their images
  are still pulled by the node without credentials, so no pod spec
  changes.
- A builder already holds a grant for its own project's repos, which
  covers the parent of a user layer and its cache. The server mints its
  own for the tag checks it makes.
- Image refs keep the node port, which is what containerd dials. Builders
  and the server address the same repos on the pod port; blobs are stored
  by repository path, so it is the same image, as it already is for a push
  through the host's port-forward.
- `yaac cluster check` gains a probe: an anonymous read of a project repo
  on the pod port must be refused.

### Cache poisoning within a project

**Within a project, a `RUN` step is not handed the grant, but the boundary
is a container, not gVisor.** A step runs under runc in its own mount and
pid namespaces, and sees its snapshot and declared mounts, nothing of the
daemon's container. That is more than today, where the step is a chroot
and can read the grant outright. A step that breaks out of its container
inside the sandbox can still read the grant and write its own project's
cache. What that gains is persistence, not reach: whoever can run that step
can already put anything in the project's images, but a poisoned entry
would outlive the Dockerfile that planted it. Three things bound that:

- **A cache has a maximum age**, 28 days unless the project sets its own.
  Each image records when its cache was started (the last build that
  imported nothing). A build past the maximum age after that imports no
  cache and starts a new one. This takes the place of `--cache-ttl`, kept
  as one timestamp. The setting is per project: Settings → Project Config →
  Images, or `yaac config image-cache-days <project> [days]`.
- **Rebuild without cache** on any build (`--no-cache`), the standard
  escape hatch.
- **An entry is the honest result of its key** unless a step escaped its
  container: the per-build daemon starts with nothing local, so no cache
  mount or leftover state from an earlier build feeds a step.

The rest:

- **One cache ref per image**: `yaac-buildcache-<project id>:<image id>`
  (and `:user` for the owner's layer). BuildKit's registry cache is one
  manifest per ref, replaced on each export, so the superseded one is
  untagged and the registry's existing collect reclaims it. The per-step
  cache tags and the GC pass that retires them are deleted.
- **Source policy** denies every image source on the main registry except
  the build's own parent ref, so a Dockerfile cannot `FROM` or
  `COPY --from` another project's image through the daemon. The daemon
  enforces it, so it only makes a hostile Dockerfile fail early and
  clearly; the gate is what holds.

### Frontends and entitlements

A `# syntax=` line makes BuildKit pull and run an arbitrary frontend
image, which then issues build instructions. Gateway frontends are turned
off (`[frontend."gateway.v0"] enabled = false`) and every build passes
`BUILDKIT_SYNTAX=dockerfile.v0`, so the line is ignored and the built-in,
pinned frontend parses every Dockerfile.

Insecure entitlements (`network.host`, `security.insecure`, `device`) stay
at their default, off.

## Standard Dockerfiles

A pod may run as a uid other than the image's, and reaches the image's
files through group 0 (docs/arbitrary-uid-images.md). Today the Dockerfile
author pays for that: `umask 002` at the head of every `RUN` that writes
under `/home/yaac`, and `yaac:0` wherever ownership is named. Forgetting
either builds fine and fails only on a host whose uid is not 1000. Three
changes move that into the image and the builder, so an ordinary Dockerfile
is correct.

- **The umask comes from the base image.** `Dockerfile.default` sets
  `SHELL` to a wrapper that applies `umask 002` and runs the step. BuildKit
  takes a parent image's `SHELL` for the steps built on it, which podman's
  OCI-format images could not carry, so every `RUN` in the trusted chain,
  a project's image and a user's gets it with nothing written. The
  `umask 002 &&` prefixes come out of the shipped Dockerfiles.
- **`yaac:yaac` means what it says.** The base image gives gid 0 a second
  name, `yaac`, so `chown yaac:yaac` and `COPY --chown=yaac:yaac` resolve to
  the ids the pod needs.
- **The builder finishes every image with a normalize step.** After the
  Dockerfile's last instruction it runs one step, as root (through the
  `sudo` the base image grants `yaac`), that:
  - gives everything under `/home/yaac` to `yaac`, group 0, with the
    owner's bits for the group;
  - gives any file `yaac` owns elsewhere group 0 and the owner's bits for
    the group, so a `COPY --chown=yaac … /app` is writable at any uid;
  - touches only the paths that need it, and prints them and their size.

  This covers what the umask cannot: an installer that picks its own
  modes, an exec-form `RUN`, a Dockerfile that sets its own `SHELL`, and a
  `COPY` into the home directory with no `--chown`, which Docker writes as
  root whatever `USER` says. Fixing a file in a later layer copies it, so
  the step costs the size of what it fixes; the printed size is how a
  large one gets noticed, and `--chown` on that `COPY` is how it is
  avoided. A standalone image with no `sudo` gets the step as its own
  user, which fixes what that user owns and reports the rest.

The server also writes build-context files group-writable when it
materializes a revision.

`dockerfiles.test.ts`'s check for the prefix is deleted. What stays for an
author to know is "Group write is not ownership": a tool that chmods its
own config cannot be fixed by any mode in the image.

## Build egress through the proxy

A builder pod is redirected and policed like a workspace pod
(docs/workspace-egress.md), with its own identity.

- **Policy.** `yaac-builder-egress` stops allowing public addresses. It
  allows what a workspace's does (the node on netd's listener range, DNS to
  the proxy's stub) plus the main registry. A builder whose redirect is
  missing has no egress.
- **Redirect.** netd's one rule widens from "pods labelled
  `yaac.workspace-id`" to those and `yaac.build-id` pods.
- **Identity.** The server writes a registration
  (`yaac-proxy-reg-<build id>`) before the pod, as it does for a workspace,
  and deletes it with the pod. The proxy's pod watch maps the builder's
  address to it. It carries the project's allowlist and nothing more: a
  build reaches what a workspace of the project reaches. A layered
  Dockerfile's parent comes from the main registry, so most builds pull
  from no outside registry. One that does (a standalone `FROM`, or a
  `COPY --from=<image>`) needs that registry's hosts in the project's
  allowlist; `ghcr.io` is among the defaults, and Docker Hub and quay are
  not. The proxy refuses `yaac.internal` to a build, as it does to a site
  release.
- **Both halves are covered.** The daemon's own fetches (`FROM` pulls,
  `ADD <url>`, git sources) and the `RUN` steps' traffic leave from the
  same pod address, so both are redirected with no proxy configuration in
  the build.
- **Blocked hosts** a build hits are recorded against the build, and its
  page offers the same "allow for this project" action a workspace's badge
  does, followed by a retry. A blocked registry is offered with the rest
  of its hosts (Docker Hub's registry, token and CDN hosts together), so
  allowing it takes one retry, not one per host.

**A build gets the project's allowlist and none of its credentials.** The
registration marks the pod as a build, and the proxy tunnels every host and
injects nothing. That needs no CA inside `RUN` steps (nothing is
intercepted), and no credential can end up in a cached layer. Builds have
no credentials today either; private dependencies in builds are a
follow-up.

Operator openings change with this: an internal mirror a build needs is
opened for the proxy and named in the allowlist, exactly as for a
workspace; the builder-specific opening goes away.

## Images, revisions and builds

### Model

Rows live in `#db`; file bytes live in a content-addressed store on disk.

| Table | Holds |
|---|---|
| `images` | id, scope (`projectId` or `userId`), name, `currentRevisionId`, `lastBuiltRevisionId` |
| `image_revisions` | id, `imageId`, number, Dockerfile text, file manifest (`path → sha256, size`), content hash, author, optional note, time. Immutable |
| `image_builds` | id, tag, layer, `revisionId`, project, reason (`create`, `prewarm`, `save`, `manual`), status (`queued`, `running`, `succeeded`, `failed`, `cancelled`), times, error, check warnings, parent tag, resolved base digests, BuildKit version, cache-hit counts, blocked hosts, log path |

Plus `projects.defaultImageId` (null is the stock yaac image),
`projects.lastImageId`, `projects.imageCacheDays`, an `imageId` on
`queued_workspaces`, `routines` and `draft_workspaces`, and on each
workspace the image, revision and tag it launched with.

- **A build records what it consumed**: its parent tag, the digest each
  upstream `FROM` resolved to, and the BuildKit version. That answers "why
  did this image change" without attestations, which would turn every push
  into a manifest list.
- **A user's `Dockerfile.user` is the one image in their user scope**, so
  it gets revisions and build history from the same code.
- **Support files** go to `global/projects/<id>/image-blobs/<sha256>`. A
  revision's context is materialized from its manifest at build time, and
  its content hash is computed from the manifest, so resolving a chain no
  longer reads every context file.
- **Repos and grants are unchanged.** All of a project's images share
  `yaac-proj-<id>`; a tag is `hash(parent chain, revision content)`.
- **The driver is handed a revision, never looks one up**: `prepareImage`
  takes the resolved Dockerfile, context path and hash from `#domain`, and
  reports build progress through a sink `#domain` supplies, which is what
  writes `image_builds`.

### Revision behavior

- **Every save that changes content is a revision.** Saving identical
  content is a no-op.
- **A save starts a build at once** (reason `save`), rather than waiting
  for the prewarm sweep. The build's check runs first, so a save is linted
  within seconds of the pod starting. A user image that is not layered is
  refused at the save itself, as today.
- **A create takes the image's last built revision.** A save or a rebuild
  in progress never holds a create up, so spawned workspaces, queued
  creates and routines start at once on the image that exists.
- **A create may ask for the revision being built instead**, and then
  waits for it. If that build fails, the create fails with it; it is never
  moved to another revision behind the caller's back.
- **An image with nothing built yet** has only the one choice: the create
  waits for its first build.
- **Built images: two per image.** The registry keeps each image's two
  most recent builds, the one in progress, and whatever a workload or a
  site's release still names (as the GC's live set does today). Every
  other project and user tag is retired, and the nodes drop theirs with
  it. That replaces "newest two per repo", which cannot tell one image's
  generations from another's.
- **Restore** appends a new revision with an old one's content. Restoring
  the previous revision is the quick way back from a bad edit: its content
  hashes to a tag the registry still holds, so nothing builds. An older
  one builds like any other save.
- **Revision history is kept whole.** Every revision's row, Dockerfile
  and file list stay for the life of the image. Support-file bytes are
  kept for the newest 2 revisions, and for any older one a kept build was
  made from; restoring a revision past those brings back its Dockerfile
  and says which files are gone.
- **The image sweep builds, and starts no pod.** It is the reconcile step
  that today keeps every project's chain built. A save now starts its own
  build, so what is left for the sweep is a new trusted chain: after a
  yaac upgrade every project image has a new tag and needs a rebuild. It
  rebuilds each project's default image and the image its last create
  used. Any other image rebuilds when a create next names it.
- **After an upgrade, creates keep to the rule above**: they start on the
  last build, which is on the old trusted chain, until the rebuild on the
  new one finishes.
- **The one spare per project is unchanged.** It is warmed on the image
  the project's last create used, at its last built revision, so it stays
  claimable while a rebuild runs and turns stale when it finishes. A
  create naming another image provisions as a create with no spare does.

### Webapp

- **Settings → Project Config → Images** replaces the Dockerfile section:
  a list of the project's images (the stock yaac image first, read-only),
  each opening to three tabs.
  - *Dockerfile*: the editor and support files, as today, with "Save" and
    the build it starts shown inline, its check warnings against the lines
    they name.
  - *Revisions*: number, author, time, note, build status; diff against
    the previous or the current one; restore; set as project default.
  - *Builds*: the persistent list, newest first.
- **A build has a page and a URL**: status, trigger, revision, duration,
  cache hits, what it consumed, check warnings, the steps as collapsible
  sections with their logs, blocked
  hosts with an allow action, and Retry, Rebuild without cache, and Cancel.
  Logs are still polled, by offset.
- **The sidebar pill stays** as the live signal, and links to the build's
  page instead of opening a modal. A failed build also goes out through
  `#lib/notify`.
- **Create pane**: an Image selector beside the other per-create options,
  defaulting to the project's last choice. Each image shows its state. A
  create starts on the last built revision; while a newer one is building,
  a switch offers to wait for that one instead.
- **Sites** name an image in their settings and still pin the image a
  release launched.

### CLI

`yaac image list|show|create|edit|rm|default|revisions|restore|build|builds|logs`,
and `yaac workspace create --use-image <name> [--await-build]` (`--image`
already attaches a screenshot). They replace `yaac config dockerfile` and
`yaac config user-dockerfile`, which are removed.

### Migration

A one-shot importer turns each project's `build/` directory, and each
user's, into an image named `default` at revision 1, set as the project
default. It gets an entry in docs/legacy-compat-shims.md. The content hash
of an imported revision is computed the new way, so each project rebuilds
its project layer once, mostly from cache.

## Phases

0. **Spike** (above): BuildKit under the current gVisor, the runc pin,
   timings.
1. **Engine.** Builder image in install and the e2e global setup
   (`yaac-test-buildkit:<hash>`), the `buildctl` flow, cache refs and their
   age bound, source policy, the gate's pod port, and "Standard
   Dockerfiles" (which changes the base image, so every image rebuilds
   once). Delete the podman build path, the step-cache GC and
   `--cache-ttl`. Egress unchanged in this phase.
2. **Egress.** netd selector, build registrations, proxy build mode, the
   builder policy, blocked hosts on builds.
3. **Model.** Tables and migration, blob store, importer, the revision
   handed to the driver, persisted builds and logs, GC live set, API routes
   with their route-matrix rows.
4. **Surfaces.** Images settings, revisions, build pages, the create
   selector, sites, the CLI and its e2e tests, docs (renaming
   `trust-split-builds.md`, whose split is no longer the interesting part).

Phases 1–2 and 3–4 touch different code and can run as two parallel lines
of work; phase 3 is the only one phase 4 depends on.

## Follow-ups

- **Repos as build sources, and cache refs split by trust**: outlined in
  docs/plans/build-repo-sources.md.
- **Credentials in builds.** Either the proxy's injection (needs the proxy
  CA inside `RUN` steps) or explicit `RUN --mount=type=secret` fed from
  named project secrets.
- **A warm per-project cache**, kept between builds so a cold one skips the
  parent pull. Needs `BUILDKIT_CACHE_MOUNT_NS`, BuildKit's own GC limits,
  and an answer for multi-node clusters.
- **KVM platform** for runsc where `/dev/kvm` exists.
