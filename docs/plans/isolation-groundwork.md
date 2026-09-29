# Isolation groundwork

## Why this plan exists

yaac's sandbox (gVisor plus egress mediation) keeps a worktree's code off the
host and off the network. It does much less to keep one worktree's code
off *another worktree's* state, or another project's, or the install's. Many
of those gaps are live bugs on a single-user install today. Under
docs/plans/multi-user-deployment.md they turn into cross-user channels, and
ownership checks enforced over them would mean nothing.

This plan fixes the gaps that need no notion of a user. It adds no
`Principal`, no owner column, and no policy. It:

- takes over the "precondition hardening" list (phase 0) of
  docs/plans/multi-user-deployment.md,
- adds four problems that plan's audit missed (workstreams 2–4 and the
  credential harvest in 3.1),
- closes [#117](https://github.com/bsklaroff/yaac/issues/117): builder pods
  can write any `repo:tag` in the shared registry (workstream 5).

Each numbered step in "Implementation order" is one change that keeps the
tree green. The workstreams are mostly independent; "Dependencies" lists
where they are not.

## Threat model

The adversary is **code running inside a sandbox**. That means an agent
under prompt injection, a malicious dependency's install script, or an
agent-authored `RUN` step in a builder pod. It holds:

- everything its mounts let it write,
- whatever its NetworkPolicies let it reach,
- whatever the server later does with bytes it wrote.

The API is out of its reach under k8s: the server's ingress policy excludes
worktree pods, and `yaac-mama` is the one sanctioned channel. The target
property:

> Nothing a sandbox does changes what a *different* worktree, a *different*
> project, or the install itself later sees, except through a channel this
> plan names as shared by design.

Two items (1.3 and 1.4) are client-side, not sandbox-side. They are here
because multi-user phase 0 listed them and they are cheap.

**Shared by design, and not changed here.** The per-user versions of these
are multi-user phase 3 work:

- the project's clone objects;
- the project's tool-home *configuration* (settings, skills, plugins). Its
  transcripts become per-worktree in docs/plans/per-worktree-agent-history.md;
- `cacheVolumes`, a per-project cache on purpose;
- the nested-container image cache inside one project (see 5.6);
- the pnpm store under `containerless`;
- the proxy's fate-sharing (CA, DNS stub, queues).

`containerless` gets correctness fixes from this plan but no isolation. Its
workspace can already write the server's files directly
(docs/containerless-driver.md).

## Relation to other plans

- **docs/plans/multi-user-deployment.md.** Its phase 0 moves here, item by
  item, in workstream 1. Two items change shape along the way:
  - forwarded ports split sensitive from infra ports (1.3);
  - `/auth/fake` refuses to overwrite a real credential instead of being
    gated on `testEnv`, because this repo's own `yaac-config.json` init
    commands depend on it (1.4).

  That plan's open question "Registry containment mechanism" is answered in
  workstream 5. The answer is write grants, not digest pinning; see 5.7 for
  why. Its phase 3 builds on the project id (workstream 4), the grant
  scopes (workstream 5), and the confined-fs helper (workstream 3).
- **docs/plans/worktree-reference-clones.md.** That plan delivers the
  read-only `/repo/.git` item from phase 0, and this plan does not repeat
  it (1.6). The two are independent in order. The explorer listing it
  moves into the workspace no longer touches the checkout from the server.
- **docs/plans/per-worktree-agent-history.md.** Its `history/<wt>/`
  converge step, and the server-side transcript copier in its follow-ups,
  read and write sandbox-writable trees. They must go through
  `openSandboxDir` / `#lib/confined-fs` (workstream 3).

---

## Workstream 1: the phase-0 fixes

1.1–1.5 have shipped: one domain resolver (`resolveWorktree`) expands a
worktree-id prefix over rows and every driver lookup is exact; the
WebSocket attaches take an exact id and check the conversation id against
`agentSessionIdSchema` (`@yaac/shared/types`); `cacheVolumes` keys are a
single plain segment; the infra port range is refused in config
`portForward` and on the k8s dial, which also refuses any port the worktree
neither declared nor surfaced; `POST /auth/fake` refuses (`CONFLICT`) to
replace a real credential; and a k8s pod mounts no `.cached-packages`.
What remains is 1.6, deferred until after workstreams 2–5.

### 1.6 `/repo/.git` read-only: delivered by worktree-reference-clones

That plan makes the main clone server-owned and mounts it read-only,
closing both the pod-plants-hooks and the server-follows-links halves. Two
things from this plan interact with it:

- the checkout's `.git` stays excluded from the confined-fs `inside` root
  (workstream 3), as `files.ts` does today;
- once it lands, the throwaway git dir's link-following caveats in
  docs/server-git.md "What this does not cover" go away.

---

## Workstream 2: a worktree id is claimed once

Shipped: the worktree id is the `worktrees` primary key, a fresh create's
row is an INSERT that refuses a taken id before anything is provisioned, a
resume is an UPDATE of the row it must have, and the provisioning registry
refuses a live duplicate (docs/worktree-storage.md, "Write discipline").

---

## Workstream 3: server I/O on sandbox-writable paths

Shipped:

- **No harvest under a mediated runtime.** `harvestToolCredentials` and the
  standing sweep return at once when `runtimeMediatesEgress()`, so a bundle
  a pod plants in its tool home is never adopted into the host store.
- **One confined-fs helper**, `#lib/confined-fs` (`openRoot` with an
  `inside` or `no-links` policy): descriptor-checked walks, non-blocking
  leaf opens, capped reads, atomic writes and fd-walk deletes. The file
  editor (`files.ts`, `inside`, `.git` excluded), `prepareModuleDirs` and
  the stop-time ephemeral-modules removal go through it for the checkout.
- **Tool homes and conversation records** are opened through
  `openSandboxDir` (`#runtime/agents`): `no-links` rooted at the dir itself
  under a sandboxing runtime, `inside` rooted at the project dir under
  containerless (`sandboxLinkPolicy`, the one driver-kind branch). Seeding
  (`seedClaudeJson`, `seedClaudeSettings`, `ensureAgentReporters`), every
  transcript and record reader, codex's model cache, skills discovery
  (`SKILL.md` capped at 256 KiB) and `reconcileSharedSkillRoots` use it. A
  recorded transcript path resolves only under the recording tool's own
  home (`recordedTranscript`).
- **Sandbox-supplied ids** — a pane-reported conversation id and an ACP
  agent's minted `sessionId` — are held to `agentSessionIdSchema` (now
  also requiring a leading letter or digit) before any path is built.
- Whole-tree deletes (`deleteWorktreeState`, `purgeProjectBytes`) stay
  plain `rm`, with their no-live-pod precondition stated where they run.

Consequence under containerless: a personal skill that is a link out of the
project dir is no longer listed by skills discovery (the agent itself still
loads it).

---

## Workstream 4: projects get an immutable id

Shipped. `projects.id` (uuid, unique, minted at insert, never reused) names
every per-project object outside the data dir, so a project re-added under a
freed slug inherits nothing whether or not the old one's removal succeeded.
The data dir (`global/projects/<slug>/`) and every row keep the slug.

- **Plumbing.** The runtime is handed a `ProjectRef { slug, id }` and never
  looks the id up: `SubstrateIntent.projectId`, `prepareImage`,
  `destroyProjectSubstrate`, and `PassContext.projects()`, which now rejects
  rather than resolving empty. Worktree pods carry `yaac.project-id`, which
  the image salvage and the registry's NetworkPolicies select on.
- **Names.** `yaac-reg-<id>` (and its PVC, policies and one-shot pods),
  `yaac-proj-<id>` for the project layer (formerly a tag in `yaac-base`),
  `yaac-user-<id>`, `yaac-buildcache-<id>`, and the node-local
  `projects/<id>/` and `shared-images/<id>/`. The in-memory per-project maps
  are keyed by id.
- **Slug hygiene.** `addProject` derives a valid label value
  (`[a-z0-9._-]`, alphanumeric ends, ≤ 63).
- **Id-keyed GCs, all permanent.** The `orphan-registry-gc` step removes
  this install's registries whose id is not live or that carry none; the
  node-local sweep (`reapNodeLocal`, now also under containerless) removes
  any project tree no live id holds unless a live pod mounts it; the main
  registry's GC deletes `yaac-{proj,user,buildcache}-<x>` for a dead `x`
  unless a workload names one of its tags. `removeProject` drops the
  Keychain item.

There was no `project.json` left to adopt an id from, so existing projects
get a fresh id from the migration default and pay the upgrade cost once:
cold nested caches and one rebuild per custom layer; the GCs above reap the
slug-named leftovers. Pods started before the upgrade carry no
`yaac.project-id`, so a running nested worktree loses its project registry
on the first orphan pass. The old registry is removed, the new one's
policies do not admit the pod, and its salvage is skipped. It pushes nothing
and pulls from upstream until it is restarted. A pre-upgrade nested **spare**
is the same for its whole life, so drain spares across the upgrade.
Two branches exist only for pre-id objects and are listed in
docs/legacy-compat-shims.md: the orphan registry sweep's no-id branch, and
the containerless sweep's running-slug keep.

---

## Workstream 5: registry write grants (closes #117)

### 5.1 Problem

The main registry (`yaac-registry`, in the default namespace, shared by
every install and e2e run on the cluster) is plain `registry:2`: no auth,
mutable tags, no path ACLs. Builder pods must reach it, and they run
agent-authored `RUN` steps as root in a chroot, so **any build can write
any `repo:tag`** (docs/trust-split-builds.md, "Open risk"). The reachable
blast radius:

- **The trusted chain.** `yaac-base` / `yaac-tools` / `yaac-nestable`
  content-hash tags, which every worktree boots.
- **Every pinned upstream reached through a mirror tag.** `podman-stable`
  runs the root, hostNetwork store-writer pods. `curlimages/curl` runs the
  **privileged, hostPID** gVisor installer. Also affected: `envoy` (netd
  and server fronting), `verdaccio`, `yaac-registry2` for the per-project
  registries, the proxy, netd, and `yaac-server`, the server Deployment
  itself. The digest in a mirror tag's *name* is a label that nothing
  checks. So a `RUN` step can plant an image that a privileged node pod
  later boots.
- **Other projects' final images and build caches.** `--cache-from
  yaac-buildcache-<slug>` has, in builder-pod.ts's own words, "no
  provenance check".

Pods consume bare tags with `IfNotPresent`. A warm node is shielded until
kubelet image GC evicts the tag; builders pull parents fresh on every
build. Since #116, "no yaac code path publishes new bytes under an existing
tag" is the only integrity guarantee, and builder writes are the path
around it.

### 5.2 Design: writes need a grant; reads stay anonymous

Put a **write gate** in front of the main registry, inside its own pod.
`GET` and `HEAD` pass through untouched. Every write (`POST`, `PUT`,
`PATCH`, `DELETE`) must carry a **grant**: a statement signed by the
install's grant key, naming the repositories it may write and an expiry.

- A builder is handed a grant for **its own project's repositories only**.
- The trusted writers (the host installer, the server's host pushes, the
  e2e global setup) hold a grant for everything.

Reads stay anonymous, so node containerd, kubelet, the store writer and
builder parent pulls need no credentials and no change. That is also what
keeps the bootstrap simple (5.5).

This is the fix the issue and the trust-split doc name: "a push-side proxy
that mints per-build, repo-scoped credentials". 5.7 covers why it is
preferred to the alternatives.

**The repository layout makes the scopes expressible.** Today the
*untrusted* project layer is tagged `yaac-base:<projectHash>`, in the same
repo as the trusted base (`image-builder.ts`). No repo-scoped grant can
separate the two. Workstream 4 moved it to `yaac-proj-<id>`, so:

| Repo | Written by | Grant |
|---|---|---|
| `yaac-base`, `yaac-tools`, `yaac-nestable`, every mirror, `yaac-netd`, the proxy, `yaac-server`, `yaac-cluster-probe` | host installer, server host pushes, e2e setup | `admin` (`*`) |
| `yaac-proj-<id>`, `yaac-user-<id>`, `yaac-buildcache-<id>` | that project's builder pods | `project:<id>` |

Project layers whose contexts happen to be identical no longer share one
tag across projects. That cost is small and wanted: a shared tag across
projects was a cross-project write channel.

### 5.3 The gate

- **Topology.** The registry Deployment gains an Envoy container on `:5000`,
  so the Service, the `hosts.toml` entries and every client address stay
  as they are. `registry:2` moves to `127.0.0.1:5001`
  (`REGISTRY_HTTP_ADDR`), reachable only from inside the pod. Envoy is
  already a pinned yaac dependency (netd's redirect sidecar, the server
  fronting). The registry-GC pods work on the PVC directly and are
  unaffected.
- **Logic.** An Envoy Lua filter, about 60 lines, in a ConfigMap:
  1. If the method is `GET` or `HEAD` and the path is not exactly `/v2/`,
     pass.
  2. If the path is `/v2/` and there is no `Authorization` header, answer
     `401` with `WWW-Authenticate: Basic realm="yaac-registry"`, so that
     podman offers `--creds` / authfile credentials. For the effect on
     anonymous clients, see Verification.
  3. For a write, decode `Authorization: Basic`. The password is
     `base64url(payload).base64url(signature)`, with payload
     `v1|<expiry unix s>|<scope>`, where scope is `*` or `project:<id>`.
  4. Verify the signature with `verifySignature` against the grant public
     key (inline in the ConfigMap), and check the expiry.
  5. Take the repository from the path (`/v2/<repo>/blobs/…` or
     `/v2/<repo>/manifests/…`) and require it to be in scope. `project:<id>`
     covers exactly the three repos in 5.2.
  6. Answer `401` (bad or missing grant) or `403` (out of scope).
  7. `DELETE` is refused for every grant. The main registry has deletes
     disabled anyway, and GC works on storage.

  A cross-repo blob mount (`POST /v2/<dst>/blobs/uploads/?mount=…&from=<src>`)
  is checked against `<dst>` only. The source is readable anonymously
  already.
- **The gate holds only the public key.** Compromising the registry pod
  mints nothing, and the pod was already all of the registry.

### 5.4 Grants

- **Key.** An ECDSA P-256 keypair (or RSA-2048, whichever `verifySignature`
  accepts; see Verification). `yaac cluster install` generates it once per
  cluster, if absent, as Secret `yaac-registry-grant-key` in the
  registry's namespace, next to the registry it guards. Every install on
  the cluster shares it, as they share the registry. Install copies the
  private key into its own namespace's Secret for the server Deployment to
  mount, and renders the public key into the gate's ConfigMap.
- **Minting.** `mintRegistryGrant(scope, ttl)` lives in `#drivers/k8s/image-engine`,
  the host half, so install can mint without a cluster import cycle.
  - **Admin grants** are minted per push session with a 1-hour expiry by
    whoever holds the key: the server for `pushImageToRegistry`, install
    for the builtin images, and `test/global-setup.ts`, which reads the
    Secret through the kubeconfig it already uses.
  - **Builder grants** are minted by the server per build, scoped
    `project:<id>`, and expire when the build's own deadline passes, plus
    a minute. The builder pod receives the grant as an authfile in a
    per-build Secret volume, deleted with the pod. The build's `RUN`
    steps may be able to read it (a root chroot is not a boundary), and
    that is acceptable: the grant writes only the project's own repos,
    which that project's Dockerfile already controls.
- **Clients.**
  - `builderBuildArgs` / `builderPushScript` (`images/builder-pod.ts`)
    pass `--authfile` to `podman build`, for `--cache-to`, and to
    `podman push`.
  - `pushImageToRegistry` (host podman) passes `--creds`.
  - `registryHasTag` is a `HEAD` and needs nothing.
  - Nothing that pulls changes.

### 5.5 Bootstrap and rollout

- **The gate's image is the upstream digest ref**
  (`envoyproxy/envoy@<ENVOY_PIN>`), not the mirror tag, for the same
  reason the registry's own image already is (`main-registry.ts`): the
  registry cannot serve the images it needs to start. Nodes already fetch
  the registry image from upstream once at install. This adds one more
  (~50 MB) fetch, which `IfNotPresent` then keeps offline.
- **Install order.** Generate the key, apply the gate ConfigMap and the
  Deployment, then push the builtin images with an admin grant.
- **Rollout on an existing cluster.** Re-running `yaac cluster install`
  rolls the registry Deployment. It is `Recreate`, so pulls fail for the
  few seconds that takes, as on any registry rollout today. A build in
  flight during the roll fails its push, and it is retried as any failed
  build is. Builders started by an older server push without a grant and
  are refused, which is the point. No compatibility window is needed:
  every writer is either upgraded in the same install or refused.

### 5.6 The nested image cache: what this plan does and does not do

The per-project registries carry the nested-container image cache. They
are **written from inside worktree sandboxes** (salvage runs in-pod) and
read by every nested worktree of the project, through the node image
store. That is a project-shared namespace by design: any worktree of a
project can name an image, including an upstream name like
`docker.io/library/postgres:16` or a short name, that every later nested
worktree of the project resolves locally.

There is no trusted production point to pin a digest to, and no grant to
scope, because the writer *is* the sandbox.

- **Across projects** it is already closed: the NetworkPolicies are keyed
  per project, and the node store is per project.
- **Workstream 4** closes inheritance across a removal: registry and store
  are named by id.
- **Across users within one project** it is multi-user phase 3 work. The
  registry's name and the store's path are then derived from (project id,
  owner) rather than the project id: a one-line change to the key once
  workstream 4 has put a key there. That plan's audit should list this
  surface next to the tool homes, and its "different feature" dismissal of
  the per-project registries is corrected there in the same change as this
  plan.

### 5.7 Alternatives considered

- **Digest pinning alone** (the multi-user plan's lean, and #113's
  unlanded `registryDigestRef`).
  - Pinning consumption to a digest makes a substituted tag unrunnable,
    but only if the digest was recorded at a trusted point. #113 resolved
    it at launch by `HEAD`ing the mutable tag: a time-of-check/time-of-use
    gap that pins whatever the tag holds at that moment.
  - It never covers the build cache. A poisoned `--cache-from` entry
    becomes a cache hit for a `RUN` step at *build* time, and the digest
    then recorded is the poisoned image's.
  - So it does not close #117, and with grants in place it adds little. It
    remains the right fix if yaac ever re-pushes a tag deliberately (#108's
    staleness class). That is not in scope here.
- **Registry-native token auth (`auth: token`).** It needs a realm service
  that answers anonymous requests too, since containerd pulls
  anonymously. That service must mint a token per requested repo, because
  distribution's access claims name repos exactly, with no wildcards, so
  the realm must hold the private key. It must also be reachable from the
  node's network namespace by IP, and be up before the registry can serve
  its own image. That is more moving parts than a write-only gate, for the
  same scopes.
- **One registry per trust level** (builders write only their project's
  registry and read the trusted chain from a read-only replica). It fits
  the per-project-registry pattern, but costs:
  - a registry and PVC for every project with a custom layer;
  - a second `registry:2` in read-only mode on a shared RWO PVC, which
    ties it to one node;
  - moving every consumer's image host.
  All for the same outcome.

### 5.8 Tests

- **Unit `test/drivers/k8s/image-engine`:** `mintRegistryGrant` round-trips
  with a verifier written to the same wire format. The Lua itself is
  exercised only in e2e.
- **e2e (k8s, host-only), in the registry-touching suite's `beforeAll`
  fixture:**
  - An anonymous `GET /v2/_catalog` and a manifest `HEAD` succeed.
  - A push with a `project:<a>` grant to `yaac-user-<a>` succeeds.
  - The same grant is refused (403) for `yaac-user-<b>`, `yaac-base` and a
    mirror repo.
  - An expired grant and a missing grant are refused (401).
  - A real nested-project create still builds and boots, which covers the
    builder authfile path end to end.
- **`cluster check`** gains a probe: an anonymous push to a scratch repo is
  refused. Without it, a registry rolled by an older install silently
  reverts to an open one.
- **Docs.** docs/trust-split-builds.md: the "Open risk" section is replaced
  by the gate's description, and its stale text about the registry's
  port-forward is corrected while it is being edited.

---

## Implementation order

Each numbered step is one reviewable change.

1. ~~3.1 harvest gate~~, ~~Workstream 2~~, ~~1.1~~, ~~1.2–1.5~~, ~~3.2–3.4~~,
   ~~Workstream 4~~: shipped.
2. **Workstream 5.** Repo layout (`yaac-proj-<id>`), then key and minting,
   then the gate and client authfiles in one change, since a gate without
   clients breaks every build.

1.6 (worktree-reference-clones) follows after workstream 5.
per-worktree-agent-history can start now.

## Dependencies

- **5 needs 4.** Grant scopes (`project:<id>`) and the per-project repo
  names come from the project id. Scoping by slug would close the
  cross-project writes, but a re-added slug would then inherit the old
  project's repos and write rights, and moving off slugs later means a
  second rename and rebuild.

## Legacy-compat entries (docs/legacy-compat-shims.md)

Workstream 4 added "Registries named before project ids" and "Workspaces
started before project ids". The id-keyed GCs themselves are permanent,
because they sweep failed removals as well as pre-upgrade names. The
registry gate has no compatibility window (5.5).

## Docs to update on ship

- **docs/trust-split-builds.md:** the gate and grants (workstream 5).
- **docs/server-git.md:** once worktree-reference-clones lands, not
  before.
- **docs/plans/multi-user-deployment.md:**
  - phase 0 becomes a pointer to this plan;
  - its registry-containment open question is answered;
  - its per-project-registry dismissal is corrected (5.6);
  - its phase 3 names the (project, owner) keys that workstreams 4 and 5
    leave room for.

  Do this in the first change of this plan, so the two plans never
  disagree.
- **This plan is deleted when its last workstream ships.** Anything still
  worth keeping moves into the docs above.

## Verification before building

Check each of these against the pinned binaries, not web docs, before the
change that depends on it:

- **Envoy Lua (pinned `ENVOY_PIN`):** `verifySignature` accepts the chosen
  key type, and base64 decoding of the `Basic` header is available or
  small enough to inline.
- **podman / buildah (pinned `podman-stable:v5.5` and the host's):**
  - with `/v2/` answering a `Basic` challenge, `--creds` / `--authfile`
    credentials are sent on writes;
  - `--cache-to` honors `--authfile`;
  - an anonymous `podman pull` still succeeds.
- **containerd (kind's):** a pull resolves manifests and blobs without ever
  requesting `/v2/`, so the anonymous challenge there never fails a node
  pull. If it does request it, the gate answers 200 to anonymous `/v2/`,
  and podman is given credentials preemptively through its authfile
  (verify it sends them unprompted).
