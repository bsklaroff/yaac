# Multi-user deployment: principals in the layered server

## Goal and trust model

Several teammates share one always-on yaac deployment. Each has their own
projects, worktrees, tool credentials and quota; the first cross-user feature
is **read-only access to each other's session logs** (agent-conversation
transcripts, in docs/naming.md terms), with the roadmap's §2 collaboration
features (observable sessions, presence, handoff, comments, team projects)
as the trajectory.

Trust model: the trust boundary is the tailnet, as in docs/remote-hosting.md.
Users are teammates who trust each other and the host admin; per-user
separation is **organizational** (own data, own credentials, own worktrees),
not adversarial. The adversarial boundary stays where it is today: the
gVisor + egress sandbox around worktree pods.

That last sentence fixes which substrate a multi-user deployment runs on.
Under the `k8s` driver a worktree holds sentinels and the egress proxy holds
the credentials, so "whose credential" is a question the deployment can
answer per worktree. Under `containerless` (docs/containerless-driver.md)
every worktree is a tmux server running as the server's own OS user, with
the real OAuth bundles and API keys in its workspace, and the server itself
is a process on that machine — there is no boundary between one user's agent
and another user's data, or the host. **The multi-user deployment is a
`k8s` deployment.** The principal plumbing is driver-neutral (it lives above
the driver seam), so a containerless install runs the same code and gets
ownership as organization — grouping, read-only views, attribution — but it
cannot get credential or filesystem separation, and this plan does not
pretend otherwise.

## The structural decision

There are two ways to partition a system by user: give each user a process,
or give each row an owner. A process boundary cut through a cohesive object
model costs a facade at every call site, a back-channel for the reads that
cross it, lookup inversions (rows become reports, reads become pushed
inputs), and lint lists to hold the line — all of it indirection with no
payoff unless the endgame is genuinely per-user isolation, which the trust
model above does not ask for.

So this plan takes the second way: **one server, and `Principal` as a value
that flows down the existing layers**. Users partition the data, not the
process. Process seams, when they come, should follow technical boundaries
(the session-operator plan's host-vs-cluster split), never organizational
ones.

What makes this cheap rather than invasive is a property the layered server
already has (docs/layered-server.md): **every write a user can cause flows
through a domain mediator, and the layers below domain never initiate
intent.** Authorization needs exactly one chokepoint, and domain verbs
already are it.

## Facts that shape the design

- `tailscale serve` injects spoof-stripped `Tailscale-User-Login` /
  `Tailscale-User-Name` headers on proxied tailnet requests (Funnel traffic
  gets none) — identity with no login UI, no OAuth, no password store.
- The server today has no identity model: `cookieOrBearerAuth` in
  `packages/server/src/api/http/web-auth.ts` resolves "credential valid?"
  from the lock secret, `isValidToken` or `isValidSession` — all boolean —
  and writes nothing onto the request. Nothing user-shaped exists in the
  schema; the one non-server identity axis is per-worktree, not per-user
  (`worktrees.mamaTokenHash`, the bearer a containerless worktree presents to
  `POST /worktree/mama`). That absence is an asset — there is no wrong model
  to migrate off.
- The credential gate already has exactly two shapes, and tokens are a
  third thing layered on both: `isCredentialOptional` trusts every local
  process on a loopback-only install, and a fronted install
  (`YAAC_ALLOWED_HOSTS` / `YAAC_TRUST_PROXY`) trusts what `tailscale serve`
  forwards. Durable tokens, one-time exchange tokens and web sessions exist
  because the middleware throws identity away; once it keeps it, nothing
  they buy is left.
- Observed facts enter db through one door (`applyWorktreeEvent`), and
  the substrate has no users in it. So principals annotate **intent**, never
  observation — the event union, the runtime contract, and everything under
  `src/runtime`/`src/lib` stay user-free.
- **Transcript reading has shipped, single-user.** `GET
  /worktree/:id/agent-sessions` and `GET
  /worktree/:id/agent-sessions/:sessionId/transcript` resolve the worktree
  *row* (not the pod), so a stopped worktree answers; `getAgentSessionTranscript`
  in `#domain/worktrees` reads an `acp` conversation's JSONL
  (`projects/<slug>/acp/<worktreeId>/<agentSessionId>.jsonl`) and replays a
  `tui` claude conversation through `readClaudeTranscriptAsAcp`, refusing
  other tools with `NOT_SUPPORTED` and oversized files with `TOO_LARGE`. The
  SPA's `StoppedTranscript` renders it through the same `AcpTranscript`
  component the live chat pane uses. The sharing feature is therefore a
  policy grant over an existing read path, not a read path to build.
- `/acp/attach` is *not* that read path: it requires a live conversation
  and every connection gets the write frames (`prompt`, `cancel`,
  `permission`).
- Worktree port forwards bind nothing on the server (docs/port-forward-tunnel.md).
  The server declares a host port per forward; a client (`yaac forward`, the
  desktop app) holds the listener and opens one `GET /forward/attach` WS per
  TCP connection, authenticated by the same bearer as every other WS.
- The SPA is same-origin only (`OPTIONS` → 405, root-absolute URLs), which
  a single shared origin satisfies trivially.
- PGlite is single-writer and embedded — one server process keeps the
  database exactly as it is.

## Architecture

```
TAILNET
  alice, bob, carol ── https://srv.<tailnet>.ts.net ── browser + CLI + phone
                              │
SHARED HOST                   ▼
  tailscale serve → 127.0.0.1:<server port>   TLS + identity headers
      → kind port-mapping → NodePort 30787 → the server pod (8787)
  ONE yaac server                        principal-aware layered server
  one cluster, one namespace, one registry, one data dir, one DB
```

No gateway process, no routing, no per-user provisioning: `tailscale serve`
fronts the one server (a pod, per docs/server-in-cluster.md, published at a
host loopback origin), and the server itself terminates identity. Deployment
env such as `YAAC_ALLOWED_HOSTS` / `YAAC_TRUST_PROXY` reaches the pod by
re-running `yaac cluster install`, which is how `YAAC_IDENTITY` below arrives
too.

### Identity terminates in `api/http`: loopback or tailscale, no tokens

The auth middleware stops asking "is this credential valid?" and answers
"who is this?" instead — and there are only two answers, so the token
machinery goes. A request is either **local** (it reached the bind without
passing through `tailscale serve`) or **proxied** (it carries serve's
`X-Forwarded-For`), and each resolves a `Principal` its own way:

- **Proxied**: the identity is the tailnet's. The cheap form reads the
  spoof-stripped `Tailscale-User-Login` header; the robust form asks
  tailscaled's LocalAPI `whois` about the forwarded address, which returns
  the node and its user. `whois` is the one to build on: it covers tagged
  devices (which carry no user header) by naming the node, and it gives
  **device** identity — which is what per-device token revocation was for.
  Revoking a lost laptop becomes removing it from the tailnet, in the one
  console that already governs who can reach the server at all. A proxied
  request that resolves to no user — Funnel traffic, a tagged node with no
  owner — is **refused**, never mistaken for local.
- **Local**: the built-in owner principal, on the standing reasoning of
  docs/remote-hosting.md — a local process can already reach loopback, read
  the data dir and hold the lock, so a credential never defended against
  it. What still defends a local browser against a malicious site is the
  three browser-enforced guards (`Host`, `Origin`, `Sec-Fetch-Site`), which
  stay.

One env knob, `YAAC_IDENTITY=tailscale` (read in
`packages/shared/src/env.ts`, propagated into the server Deployment like
`YAAC_TRUST_PROXY`, which it absorbs), turns the proxied resolution on. A
second value, `YAAC_IDENTITY=tailscale-only`, refuses local requests too, so
even a client on the server's own machine addresses the ts.net name and is
identified by it — this is the shared-OS-user host that `YAAC_REQUIRE_AUTH`
covers today, now stated as a property of identity rather than a gate.
Unset means a local-only install: every request is local, one implicit
owner. **Single-user is the degenerate case of multi-user, not a fork** —
local installs run the same code with one implicit principal, so nothing
about local development or the existing e2e topology changes.

Under `k8s` "local" needs one more sentence. The server is a pod that binds
`0.0.0.0` and never sees a `127.0.0.1` peer; a request from the host arrives
through the kind port-mapping with a node-side source address. So local is
defined as *not proxied by serve*, never as a peer address, and the pod's
ingress NetworkPolicy — which keeps every worktree pod off the server
(docs/server-in-cluster.md) — is load-bearing for authentication, not
hygiene: a pod that could reach the bind would be "local". `whois` from
inside the pod means hostPath-mounting the tailscaled socket into the
server Deployment; the header form needs nothing.

What this deletes, all of it single-user simplification that can ship
before any tenancy:

- The `tokens` table, the token store and its per-kind FIFO caps, the
  `/tokens` routes, and `yaac auth token create|list|revoke`.
- The one-time exchange token, the `?token=` bootstrap, the session cookie
  and web sessions. A browser on the tailnet is identified on every
  request; a local browser is covered by the loopback guards. `yaac open`
  just opens the URL.
- The lock-secret bearer and the mint in `registerServer`
  (docs/server-selection.md): the lock secret exists so a client can
  authenticate *as the server* to mint itself a durable token. With no
  tokens, `server.json` is an origin and a driver, and the `BAD_BEARER`
  re-read-and-retry goes with it.
- `YAAC_REQUIRE_AUTH`, `YAAC_TRUST_PROXY` (folded into `YAAC_IDENTITY`), the
  `YAAC_WORKTREE_ID` credential skip (a nested server is only ever reached at
  loopback, which is local by definition), and the "beware a fronted server
  started from inside a worktree" caveat — which exists only because a token
  gate can silently drop.

What stays: the per-worktree mama bearer (`worktrees.mamaTokenHash`) and
the proxy's relay secret are worktree *attribution*, not user auth, and a
worktree pod cannot carry a tailnet identity.

What it costs: remote hosting is tailscale-only, which is the documented
stance already (trust boundary is the tailnet; never Funnel) — a
non-tailscale remote deployment is not supported rather than
token-supported. And every remote client, CLI and desktop app included,
addresses the ts.net origin, which `yaac remote set <url>` already does.

### Principals flow down as arguments

Domain verbs take the principal explicitly — same discipline as the
reconciler's per-pass accessors and "no substrate step reads a row": no
ambient request context, no thread-local. Routes stay translation-only; they
pass the principal a middleware resolved.

A new sealed domain folder, `domain/access`, owns the vocabulary: the
`Principal` type, the action names, and `authorize(principal, action,
resource)` — policy in one place, like `spawn-policy`. The intended v1
policy is *any authenticated principal may read anything; only the owner
may write*, and read-only log sharing is that policy plus the transcript
route. But the audit below establishes that **"read vs. write" is the
wrong axis to enforce on** — the real partition is three-way:

- **Genuine reads** (worktree list, detail, transcript, diff): safe to
  share, modulo the field-level secret leaks catalogued in the snapshot
  finding.
- **Action-shaped reads** — endpoints that look like reads but grant code
  execution or reach: every `/pty/attach` target, the `prompt`/`cancel`/
  `permission` frames on `/acp/attach`, and `/forward/attach` (a tunnel into
  the worktree's listeners). These are `act`, gated to the owner, never
  "read".
- **Writes**, further split into *own-resource* (owner-gated) and
  *install-global* (admin-gated) — the audit found the second class is
  large and mostly unguarded today.

So `authorize` takes an **action verb** (`read` / `act` / `write` /
`admin`), not a boolean, and the transcript sharing feature is the one
`read` grant across owners — deliberately narrow, because the audit shows
how much of the surface is *not* a safe read.

### Db: owners on rows, and nothing below changes

- A `users` table (login, display name, first/last seen) and an `owner`
  column on `projects` and `worktrees` (Drizzle migrations; existing rows
  backfill to the built-in owner).
- `preferences` and `shortcut_overrides` become per-user rows. They are
  described today as "the user's" — now there are several — and
  `preferences` has grown a git identity (`git_user_name`,
  `git_user_email`) that decides what every worktree commits as, which is
  the most visibly wrong thing to leave install-global.
- The event door is untouched. `WorktreeEvent` carries no principal;
  ownership is stamped when the *intent* row is created (the create verb),
  and discovery/observation continue to fill facts onto rows whose owner is
  already decided.

### Store: credentials and tool homes key by owner

Where things live today, because it decides what "owner-keyed" means for
each:

- Tool OAuth/API-key bundles are flat files, `.credentials/<tool>.json`
  under the data dir, mirrored into each project's tool home; git HTTPS
  credentials are `.credentials/github.json`. Both stay files because the
  proxy pod reads them off its `/yaac-credentials` mount per request and
  writes refreshed bundles back.
- Git SSH keys are sealed rows (`git_ssh_keys`), handed to the proxy's
  in-memory ssh-agent, a containerless worktree's agent, or a short-lived
  host file. Project env and proxied secrets are sealed rows too
  (`project_env_vars`), pushed to the proxy over `PUT /secrets` and held in
  its memory — only `secretRef`s persist.

Two moves, not one:

- Host-side credential bundles move from `.credentials/<tool>.json` to
  `.credentials/<user>/<tool>.json` (and `github.json` likewise). The
  auth-daemon flow already rides an authenticated connection, so the server
  knows which user's bundle is arriving. Per-user quota falls out: each user
  signs into their own Claude/Codex accounts. The sealed-row stores gain an
  `owner` column on the same terms.
- **Tool homes gain an owner segment.** Today `projects/<slug>/claude/`
  (and `codex/`, `pi/`, `opencode-config/`) is mounted RW into *every*
  worktree pod of the project — settings, account state, and transcript
  files shared and mutually writable across whoever owns those worktrees
  (docs/worktree-storage.md calls every worktree "a concurrent writer into
  one transcript directory"). Per-(project, owner) tool homes make a pod
  mount only its owner's agent state, and put each transcript under its
  owner by construction — which is also what keeps "whose log is this" a
  path fact for the sharing feature. The `#runtime/agents` transcript
  locators, `agent_sessions.transcriptPath`'s project-relative convention
  and the containerless symlink set gain the segment; the phase-3 migration
  backfills existing dirs to the built-in owner.

The project repo clone (`projects/<slug>/repo`) stays shared across the
project's worktrees regardless of owner — that is the existing
multi-worktree trust class, and branch isolation is what already carries it.

### Runtime and platform: no user vocabulary

The runtime driver contract, the k8s driver, images, egress, terminals —
none of it learns that users exist. A driver is handed paths and intents,
never a lookup (`docs/layered-server.md`), and that is exactly the shape
ownership needs.

Two mechanisms do become owner-keyed *through the worktree*, without the
runtime ever seeing a user: the pod spec mounts whichever tool-home and
credential paths the store staged for that worktree (a path change only),
and the egress proxy's credential machinery. The proxy piece is real work,
not a relabel: today injection is deliberately **not** keyed at all — the
proxy resolves the placeholder sentinels against one install-global bundle
file per tool, and its own comment states that "any agent in any worktree
may now spend any credential the host has signed in". The proxy already
resolves every request's source IP to a worktree registration (the
attribution machinery per docs/worktree-egress.md) and keeps per-worktree
allowlists and injection rules; the change is that a registration gains a
credential-set key, staged by the server from the worktree's owner, and
every credential path resolves through it: sentinel swaps, the GitHub token
pool, and which ssh-agent identities a worktree's connections may list and
sign with (today's `sshAgentGate` checks only that the caller is a worktree
and the remote is SSH-shaped, not whose key it is). The OAuth **refresh
write-back** must route the same way — the proxy captures Claude/Codex
token-refresh responses and overwrites the stored bundle, so today any
worktree can rotate the credential every other worktree uses; under
ownership it writes back only to its owner's bundle.

Under `containerless` the equivalent machinery is `#domain/auth`'s
credential-sync, which harvests a refreshed bundle from a project's tool
home up to the host store and pushes the host store's back down. With
owner-keyed tool homes and bundles it converges per (project, owner) for
free — but as the trust-model section says, that is bookkeeping, not
separation: the workspace holds the real token either way.

### API surface

- The snapshot hub's `buildSnapshot()` becomes principal-aware only in what
  it *labels*, not what it hides: v1 policy is read-everything, so the
  snapshot gains owner fields for the UI to group by (mine vs. teammates),
  and per-principal filtering becomes a policy question for later, not a
  hub rewrite now.
- The transcript route is the shared read; `authorize(read)` on it is the
  whole sharing feature. Its tool coverage (claude JSONL; codex/pi later;
  opencode leaves no host record) is a single-user gap, not a tenancy one.
- Write routes call `authorize` via their domain verbs; the PTY, ACP and
  forward attach upgrades authorize as `act`. A read-only live view — the
  ACP replay minus the write frames, or a PTY tee minus stdin — is roadmap
  §2's "observable sessions", not part of v1.

### Frontend

Ownership-aware, not two apps: worktrees grouped mine-first with teammates'
visible read-only (no PTY input, no chat input, no lifecycle buttons —
driven by an `owned` flag on the snapshot rows), and the existing stopped
transcript view opened for a teammate's running worktree too — the static
route already renders through `AcpTranscript`, so "view a teammate's
session" is the same pane fed from the same endpoint. This is the roadmap's
"shared / observable sessions" row arriving as a view-mode rather than a
separate surface; a *live* view of a teammate's agent is the §2 item that
follows.

## Shared-surface audit

Every backend surface where one user's action could write state another
user's worktrees consume, and its disposition. (The proxy findings come
from `k8s/proxy/proxy.ts` and docs/worktree-egress.md; the intended model
there reasons about isolation between *installs*, not between users of one
install, which is why several of these exist.)

**Becomes owner-keyed in phase 3** (rows/paths/registrations gain the owner
dimension):

- Proxy credential injection, refresh write-back, GitHub token selection,
  ssh-agent identity filtering — see the runtime section above.
- Tool homes and host credential bundles — see the store section above.
- **The prewarm pool.** Spares take the normal create path
  (`prewarm-reconcile` calls `createWorktree` with `prewarm: true`), so
  their tool-home and credential mounts are fixed at spare creation and pods
  cannot be remounted — a spare is owner-bound the moment it exists. The
  pool (`computePrewarmPlan`, per project, `YAAC_PREWARM_POOL_SIZE` spares)
  becomes per-(project, owner), and claim filters by owner.
- **The global user Dockerfile** (`PUT /config/user-dockerfile`) is
  "applied as the top layer of every project image" — one user's edit runs
  in every user's future sandboxes. V1: admin-only (policy), keeping one
  image chain; per-owner top layers (and per-owner image chains, which the
  content-hash tags would absorb) only if personalization proves worth the
  build fan-out.
- Per-user UI/preference state that is install-global today and hence
  cross-user writable: default tool, git identity, shortcut overrides, and
  worktree death read-marks (`deathSeen` on the row, surfaced by
  `/worktree/list-stopped`; `mark-all-deaths-seen` dismisses for everyone).

**Changes scoping semantics** (today's scope is wrong for multi-user, and
two are dubious even single-user):

- **Proxied secrets are per-project, not per-owner.** The cross-*project*
  half is fixed: secrets are `project_env_vars` rows, sealed at rest, and a
  `secretRef` is scoped `<projectSlug>/<NAME>`, so one project's rule can no
  longer resolve another's value. What tenancy adds is the owner dimension
  where the value is user-supplied.
- **Persistent allow-host and forward-port approvals fan out
  project-wide.** `persist:true` writes the host or port into the project
  config overlay and then passes `fanOutToProject` to the driver, widening
  every running sibling worktree — under ownership, that is a project
  *write* (owner/team-gated); non-owners get per-worktree, non-persistent
  approvals.
- **Builder pods can write any tag in the shared registry.** Builders push
  to the main registry (`yaac-registry.yaac.svc`), an unauthenticated
  `registry:2` that accepts pushes to any `repo:tag` from pods running
  agent-authored Dockerfile `RUN` steps; docs/trust-split-builds.md states
  this open risk plainly, and the per-project build-cache repo says its
  confinement "is not a boundary". The per-project registries in
  `#drivers/k8s/cluster` are a different feature (nested `docker push`
  targets) and do not sit on the builder path. Single-user it is
  self-poisoning; multi-user it is one user's *agent* overwriting the image
  another user's next worktree boots — and consumption is by content-hash
  *tag*, so an overwritten tag is what the next pod pulls. Containment
  (registry auth / per-project push scopes / digest-pinned consumption)
  graduates from "open risk" to a phase-3 prerequisite.

**Stays shared by design** (availability or teammate-trust class, named
rather than fixed):

- The single proxy pod and its install-global fate-sharing: MITM CA (one
  key transits everyone's traffic), DNS stub, leaf-cert cache, the mama
  command queue (`MAMA_MAX_PENDING_TOTAL` across the install, with a
  per-worktree cap beside it) and ssh-agent connection caps (a busy
  worktree can starve siblings — a fairness knob to revisit, not a
  correctness hole), and the shared state files under `run/proxy-data/`.
  Attribution itself is sound: the pod-watch index maps source IP to
  worktree, filter chains are per pod IP with no default chain, transparent
  ports are node-CIDR-gated, and the relay handshake carries the
  server-authored proxy secret.
- The project repo clone, mounted read-write into every worktree pod of
  the project — the existing multi-worktree trust class; branch isolation
  carries it, and `git-auth-failures` records staying project-scoped
  matches it.
- Forwarded worktree ports are whatever the *client* binds: `yaac forward
  --bind <tailnet ip>` re-exposes a worktree's dev server to the whole
  tailnet ungated, and that is the forwarding user's choice about their own
  machine, not a server surface. The server-side half, `/forward/attach`,
  is `act`-gated (below).

### Projects under ownership

Projects are the one resource where "read all, write own" is not enough of
an answer, because slugs are a global namespace and the clone is heavy.
Two coherent shapes:

- **Owner-private projects**: only the owner creates worktrees. Two users
  working the same repo either collide on the slug or duplicate the clone
  and the image chain.
- **Communal projects** (recommended): any authenticated user may create
  worktrees in any project — the worktree is owned by its creator; project
  *mutation* (config, env and secrets, Dockerfile, build files, delete)
  stays owner-gated. Creating a worktree in someone's project means running
  their config and image — the same trust class as sharing the repo — and
  it is the shape team projects grow into. Project delete gains a guard:
  blocked (or force-gated) while non-owner worktrees exist.

**Git authentication stays per-user under communal projects — that is
what makes them safe.** The upstream provider's per-user permissions are
the one real external ACL in the system, and every git path presents the
*requesting user's* credential, never one ambient to the project: host-side
fetches on the shared clone (create/restart, base-branch resolution) run
with the worktree creator's credential — and because create unconditionally
runs `fetchOrigin` and fails on a fetch error, every private-repo create
*is* an upstream access check for the creator, with no separate probe to
add (a remote with no matching credential fetches unauthenticated, so
public repos need none); proxy HTTPS git and `gh` token selection draws
from the owner's pool; the ssh-agent serves only the owner's identities;
and the pod's git author identity is seeded from the owner's preference
rows rather than the install's, so agent commits attribute to the right
human. Two consequences named plainly: the shared clone caches objects
across users, so once any member has fetched a repo its *bytes* are
team-readable regardless of upstream permissions — consistent with the v1
read-everything policy, and the reason a repo some teammates must not read
does not belong on a shared deployment until per-project visibility
exists. And the proxy's `git-auth-failures` records, today keyed per
project and cleared by any worktree's success, must key per
(project, owner) — one user's valid token must not mask another's expired
one.

## Permissions pitfalls found by a code audit

A sweep of the HTTP/WS surface and the pod/runtime layer turned up specific
flaws. Two structural facts frame all of them:

- **Every worktree pod runs as the same host uid, with passwordless sudo,
  on shared hostPaths** (`podUid()` in `drivers/k8s/substrate/pod-spec.ts`
  bakes the server's uid into the image; the Job sets no `runAsUser`; gVisor
  has no userns/idmap, so hostPath uids pass through raw). There is
  therefore **no filesystem-level isolation between worktrees** — owner
  separation can only come from *which paths get mounted*, never from
  permissions on a shared mount. Every "owner-key this dir" item below means
  mount-selection, and a shared-writable mount is a cross-user channel no
  policy check sees. (No entry in the mount list `createWorktree` builds
  sets `readOnly` today, though the contract field exists.)
- **Read-all is unsafe until "read" is narrowed** (the three-way split
  above), because much of what looks like a read is either execution or a
  secret disclosure.

### Preconditions — pre-existing bugs that make ownership meaningless until fixed

These are exploitable in the *current* single-user server too; ownership
cannot be enforced on top of them.

- **Empty/prefix worktree-id resolution → a shell in an arbitrary pod.**
  `findWorktreePod` (`drivers/k8s/substrate/pods.ts`) matches
  `worktreeId.startsWith(idOrName)` with no empty-string guard, and the
  `/pty/attach`, `/forward/attach` and `/acp/attach` upgrades in
  `main/server-run.ts` default a missing `id` to `''`, so `GET
  /pty/attach?id=&target=shell` resolves to *the first running pod in the
  cluster*. `resolveWorktreeContainer` delegates to the driver's `find` with
  no exact-match preference, so every `/worktree/:id/*` route inherits the
  ambiguity. The fix already exists in the same folder:
  `resolveSessionInProject` trims, rejects empty, prefers an exact match and
  reports `ambiguous` on a multi-prefix hit — propagate that discipline to
  the pod-side resolver and the upgrade handlers. **Fix first, before any
  owner lookup** — an owner check keyed off a fuzzy resolve targets the
  wrong row.
- **`/repo/.git` is mounted read-write and is a server-host escape today.**
  Any worktree can write `hooks/`, `config` (`core.hooksPath`,
  `core.fsmonitor`, `core.pager`), or `refs/remotes/origin/*`; the server
  then runs `simple-git` against `repoDir(slug)` (fetch, default branch,
  skills `ls-tree`, diffs) with `process.env` spread wholesale and runs
  those hooks **on the host** — under `k8s`, inside the server pod. Nothing
  server-side pins `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` or
  `core.hooksPath` (only the containerless *worktree* launcher does, for
  the worktree's own env). Harden regardless of tenancy: pin them on all
  server-side git, and prefer mounting `/repo/.git` read-only with only
  per-worktree `worktrees/<id>` writable.
- **`.cached-packages` lets one worktree write another's live
  `node_modules`.** The whole per-project pnpm store is mounted RW and the
  per-worktree ephemeral module backings live *inside* it
  (`modules/<worktreeId>/<slot>`, staged by `seed.ts`), so same-uid
  worktree A can write B's `node_modules` directly, and can poison the
  content-addressed store the next `pnpm install` hardlinks from. Mount
  only `<store>` plus the worktree's own `modules/<id>` slot; then
  owner-key the store root.
- **`cacheVolumes` keys are unvalidated → host path traversal.** The key is
  taken from project config and only the *value* is checked for
  absoluteness (`domain/projects/config.ts`); a key of `../../../.credentials`
  flows into `cacheVolumeDir`'s `path.join`, is `mkdir`'d at create and
  mounted RW into the pod. Validate the key (`/^[A-Za-z0-9._-]{1,64}$/`)
  now; owner-key the dirs under tenancy.
- **`POST /auth/fake` is a test seam on the production API** with no env
  gate — it overwrites the real Claude bundle and fans placeholder
  credentials out to every project's tool home, and writes a `github.com/*`
  credential entry. Gate on `testEnv` or remove from the HTTP surface.

### Action-takeover chains (multi-user)

- **`/agent/auth` socket hijack → OAuth code interception.** The WS handler
  `authAgentHub.setSocket(sock)` closes the incumbent auth-daemon socket and
  installs the caller's (`domain/auth/agent.ts`); the daemon authenticates
  like any other client, indistinguishable from a CLI. Any authenticated
  user can evict the real login broker *and* become the recipient of the
  OAuth authorization code a victim pastes at `POST /auth/login/:id/input`
  — an account-takeover chain. With identity resolved per request the fix
  is structural rather than a new credential kind: the hub holds **one
  socket per principal**, a connection can only displace its own user's
  daemon, and `/auth/login/:id/*` flow rows carry the owner (404 for
  non-owners).
- **`/acp/attach` is not a log tail.** Its `prompt` frame calls
  `conversation.prompt(text)`, `cancel` cancels a turn, and `permission`
  answers a held permission ask (`runtime/agents/acp-bridge.ts`) —
  prompting an agent is code execution by proxy, and answering its
  permission prompt more so. The route requires a live conversation, so it
  is `act`, owner-gated, full stop; replay is the HTTP transcript route. A
  read-only live socket (replay events, drop the three write frames) is the
  "observable sessions" item.
- **Every `/pty/attach` target is code execution, and no viewer mode
  exists.** `parsePtyTarget` yields `shell`/`native` (raw/tmux-prefixed
  shells), `agent`, or `window:<id>` (a TUI or another user's dev-server
  window), and falls back to `agent` for anything unrecognized. `bridge()`
  unconditionally writes binary frames to stdin, honors `signal`, and wires
  `resizeWindow` for every non-`native` target. A read-only viewer is real
  work (`runtime/terminals/pty-bridge.ts`): a `{readOnly}` path that drops
  binary and `signal` frames, skips the shared-window `resizeWindow` (a
  viewer's browser size otherwise moves the owner's pane), excludes
  `native`, and caps viewer tmux sessions per worktree. For v1, owner-only
  PTY plus the read-only transcript pane is the safe subset; a live TUI
  viewer is a §2 "observable sessions" item, not free.
- **`/forward/attach` is a bearer-gated tunnel to any worktree's
  listeners, and a nested yaac serves its full API to whoever holds it.**
  The tunnel is authenticated, but with no principal every authenticated
  user can splice into every worktree's forwarded ports. A nested yaac
  treats every request as local (today via the `YAAC_WORKTREE_ID` skip in
  `isCredentialOptional`; under the identity section, because it is only
  ever reached at loopback); docs/remote-hosting.md argues this is fine
  because the inner server is reachable only through the outer server's
  tunnel — which holds exactly as long as the tunnel is owner-gated.
  Disposition: `/forward/attach` authorizes `act` on the worktree, which
  closes both. A delegated tunnel (handoff, later) hands over the inner
  control plane with it, which is the trust class handoff means anyway —
  the delegate can already type into the agent. Separately, the
  click-to-forward `isForwardablePort` policy (`drivers/shared/port-policy.ts`,
  sensitive and infra ports) is applied only by the two port *detectors*;
  `declareWorktreeForwards` never calls it, so a config-declared
  `portForward: 9229` is honored — apply it there too.

### Install-global writes that need admin/owner gating

The audit found the "only the owner may write" rule has a large second
class — *install-global* writes any user can make today:

- **Credentials** (`api/routes/auth.ts`): `PUT /auth/git/credentials`
  wholesale-replaces the entire credential set across both stores (swap in
  your token for a victim's host pattern and their pushes go to you); `PUT
  /auth/:tool` overwrites the install Claude/Codex bundle and every
  project's mirror; `POST /auth/clear` with `service: all` wipes every git
  credential, every SSH key row and all four tool bundles. All must be
  per-user stores, agent pods mounting the owner's. `GET /auth/list` now
  masks key material (SSH rows show only a pattern and a "stored on server"
  preview) but still returns the full pattern inventory — caller-scope it.
- **Tokens** (`api/routes/tokens.ts`): `DELETE /tokens/:name` is an
  unscoped global logout (names are enumerable via `GET /tokens`, which
  lists every user's devices and browser sessions); the
  `MAX_WEB_SESSIONS`/`MAX_EXCHANGE_TOKENS` FIFO caps are global, so one user
  spamming `yaac open` evicts others' live sessions. The identity section
  resolves this by deletion rather than scoping: the routes, the store and
  the caps go, and the middleware **returns the principal** the tailnet or
  the loopback resolved — that signature (`web-auth.ts`) is the first thing
  to change, since the whole plan hangs off it.
- **Image/build surface**: `PUT /config/user-dockerfile` (top layer of
  *every* project image — highest blast radius), `/config/user-build-files/*`
  (same, and the shared `resolveRoot` signature can't express per-user until
  it takes the Principal), `PUT /project/:slug/dockerfile` and the
  `build-files` CRUD are all code-in-every-pod writes — admin or
  project-owner only. `POST /image/builds/:id/retry` can rebuild the shared
  egress-proxy sidecar (infra DoS) — admin. (All of these already answer
  `NOT_SUPPORTED` under `containerless`, which has no images.)
- **Cross-boundary fan-out writes**: `allow-host` and `forward-port` with
  `persist:true` widen every running sibling worktree of the project (an
  egress/exposure channel into other users' agents); `PUT
  /project/:slug/env` puts variables and secrets into every future worktree
  of the project; `mark-all-deaths-seen` and `POST
  /worktree/provisioning/:id/dismiss` write other users' rows; `DELETE
  /project/:slug` purges every worktree of the project. Owner/project-owner
  gated, with the provisioning registry gaining an owner field.
- **Shared preference rows**: `/tool/set` (also changes what prewarm warms),
  the git identity and `/shortcuts/*` are install-global — per-user rows
  (low severity, but reads like a bug).

### The spawn flow needs an owner carried through it

`yaac-mama` attribution is otherwise sound. Under `k8s` the proxy resolves
the caller from its source pod IP at enqueue time and the server's drain
(`mama-reconcile`) takes project and tool from the caller's live workspace
listing; under `containerless` the worktree presents a per-worktree bearer
minted at create, of which the row keeps only a hash, and a request never
names its own worktree. Both transports converge on `runMamaCommand` and
its allowlist, and a pod *cannot* spawn into another project
(`domain/worktrees/spawn-policy.ts`). Gaps under tenancy: no owner is
carried in `SpawnRequest`; the spawned worktree should **inherit the
caller's owner**, read from the caller's worktree row the drain already
resolves. The queue caps are `MAMA_MAX_PENDING_TOTAL` across the install
plus a per-worktree pending cap and `SPAWN_MAX_IN_FLIGHT_PER_SESSION` —
one user's worktrees can still fill the shared total, so add a per-owner
budget. And `decideSpawn` falls back to the install-global default tool
(request tool → caller's tool → `getDefaultTool()` → `claude`) and its
credential — resolve tool *and* credential from the inherited owner, and
fail the spawn if the owner has no credential rather than creating an
unauthenticatable worktree. The proxy `/tools` roster leaks other users'
configured tools unless filtered by caller owner.

### Snapshot field leaks

`buildSnapshot` (`api/events.ts`) serializes one payload and fans it to
every connection, so per-user filtering means giving up the
single-serialization fast path (or serializing per audience group). Fields
that are per-user-sensitive even under a generous read-all reading:
`planUsage`/`codexPlanUsage` (the credential owner's subscription tier and
live quota — billing telemetry), `gitAuthFailures` (which private hosts
exist and whose token is broken), provisioning `error`/`message` (repo
URLs, paths), `projects[].remoteUrl` (every user's private repo URLs), and
`worktrees[].prompt` (the founding user ask — free-form and the field most
likely to surprise). The transcript sharing feature wants
worktrees/sessions readable, but these fields should be owner-scoped in the
snapshot from the start.

### Skills discovered from writable dirs are a cross-user injection path

Only the packaged builtin skills are delivered read-only per worktree
(a read-only mount under `k8s`; symlinks into the install under
`containerless`). The *personal* skill tier is just the shared per-project
tool home (`claudeDir(slug)/skills`, and the codex/opencode/pi
equivalents in `domain/skills/discover.ts`), writable by the agent:
worktree A writes `~/.claude/skills/foo/SKILL.md` and every later worktree
in the project — any owner — loads it into agent context, persisting past
A's deletion. The *project* tier reads `origin/<branch>` via `ls-tree` from
the shared clone, forgeable via the `/repo/.git` write hole above.
Owner-keying the tool homes fixes the personal tier for free; the UI should
show skill provenance (which owner/worktree last wrote it) and treat
writable-dir skills as untrusted by default. Title generation, by contrast,
is **not** a quota surface — it runs a local llama.cpp subprocess against a
downloaded GGUF, no credential — so it only needs its sweep and `attempted`
set scoped by owner and `setWorktreeTitle` owner-gated.

## How the rest of roadmap §2 lands in this structure

Each next feature is rows + policy + UI in an existing layer — no new
processes, no new arrows:

- **Observable sessions** — the read-only ACP socket and the `{readOnly}`
  PTY bridge described above, each a `read` grant on a live attach.
- **Presence** — the api layer already owns connections; a registry of
  attached principals feeds the snapshot.
- **Handoff** — a domain verb mutating attachment/ownership under
  `authorize`; the PTY bridge already tees multiple clients.
- **Comments** — a db table with an author column and read policy.
- **Team projects** — `owner` generalizes from a user to a team; policy
  gains roles. The schema move is designed for by making `owner` a
  principal reference, not a string login.
- **Scaling the execution side**, if one process ever isn't enough, is the
  session-operator plan — a *technical* seam (host vs. cluster
  convergence) that composes with per-row ownership instead of competing
  with it.

## Alternatives considered

- **Per-user server instances behind a routing gateway**: a new gateway
  package routing on the identity header, one full server + data dir +
  namespace per user, a GET-allowlisted `/peer/` namespace for cross-user
  reads. Workable — coexisting installs on one cluster are an exercised
  pattern, and the main registry's PVC and the per-project registries are
  already scoped by data-dir hash — but it still needs real shared-host
  fixes (the fixed-name main registry Service, promoting
  `YAAC_K8S_NAMESPACE` from test hook, the predictable host-side
  known_hosts scratch path), N of everything (DBs, reconcile loops,
  informer sets, netd port trios), an identity relay in the gateway that
  every instance must trust, and it dead-ends at the first collaborative
  *write* feature: presence,
  handoff and comments need shared state with identified authors, which a
  router cannot own and N databases cannot share. Choosing it means
  choosing federation later.
- **One shared instance with no identity** (works today, zero code):
  everyone full-access on one server, log-sharing free via the transcript
  route. The right stopgap while phases 1–2 land, but tool credentials
  and quota are per-install (everyone burns one account), and nothing
  distinguishes users — no ownership, no read-only, no §2 trajectory.
- **A per-user process seam** (one "session manager" per user under a
  shared API tier): buys a facade at every call site, a back-channel for
  cross-user reads, lookup inversions and lint walls, for isolation the
  trust model doesn't demand — teammates on a tailnet, with the real
  sandbox at the pod boundary.
- **A standalone read-only log-viewer** over the data dirs: least code
  touching yaac, but re-implements transcript rendering in a dead-end
  second UI and advances nothing else — and the in-app viewer already
  exists.

## Phasing

0. **Precondition hardening — ship now, independent of tenancy.** The
   audit's "preconditions" are live bugs in the single-user server:
   exact-match worktree-id resolution (reject empty/prefix, in the pod-side
   resolver and the WS upgrade handlers), pin server-side git config +
   `core.hooksPath` and prefer a read-only `/repo/.git`, narrow the
   `.cached-packages` mount and validate `cacheVolumes` keys, apply
   `isForwardablePort` to config-declared forwards, and gate `POST
   /auth/fake` on `testEnv`. None of this needs a `Principal`; all of it is
   required before any owner check is meaningful.
1. **Identity without tokens — ship as a single-user simplification.**
   The middleware resolves local vs. proxied and returns a principal (the
   signature the whole plan hangs off); `YAAC_IDENTITY` replaces
   `YAAC_TRUST_PROXY` and `YAAC_REQUIRE_AUTH`; the `tokens` table, store,
   routes and CLI commands, the exchange/cookie flow, the lock-secret mint
   in `registerServer` and the `YAAC_WORKTREE_ID` skip are deleted;
   `server.json` drops its token; docs/remote-hosting.md and
   docs/server-selection.md are rewritten to the two-answer model. Every
   local install behaves exactly as before, since local was already
   credential-free; a fronted install goes from "token or header" to
   "header". The `whois` form, and the tailscaled socket mount it needs in
   the server pod, can follow the header form.
2. **Principal plumbing, no behavior change.** The `Principal` type,
   `domain/access` with the `read`/`act`/`write`/`admin` action verbs
   (sealed, tested per convention), domain verb signatures take the
   principal phase 1 resolves, the three attach upgrades authorize `act`,
   everything resolves to the built-in owner. Mechanical, revertible, and
   the layering rules make "every verb takes a principal" reviewable in one
   place.
3. **Users become real.** `users` table, `owner` columns + backfill
   migration, per-user credential subtrees
   and owner columns on the sealed-row stores, owner-keyed tool homes (dir
   migration + the locator/path-convention change + the containerless
   symlink set), the proxy's credential-set keying (injection, refresh
   write-back, git tokens, ssh-agent filtering), per-(project, owner)
   prewarm, the audit's scoping fixes (allow-host/forward-port/env persist
   as project writes, builder registry containment, admin-gated user
   Dockerfile + build-files, per-user preference rows including the git
   identity), the credential/auth-daemon fixes (per-principal daemon
   socket, owner-scoped `/auth/*`), the spawn owner inheritance +
   per-owner budget, snapshot
   field scoping, owner-keyed skills, communal projects with owner-gated
   mutation and per-user git auth, and the ownership-aware UI.
   This phase is the multi-user deployment: serve the server, add users
   to the tailnet, done. Read-only log sharing arrives here as one `read`
   grant on the transcript route, not a feature bolted on the side.
4. **§2 features** — observable sessions, presence, handoff, comments —
   each as rows + policy + UI on the standing structure.

Testing per repo conventions: `domain/access` gets its barrel-function
tests; the api project covers principal resolution (proxied header,
proxied-without-identity refused, local default, `tailscale-only`) and
write-denial for non-owners in both matrix columns — the header form needs
no tailscale, only request headers, and `whois` gets a stubbed LocalAPI;
the token commands' e2e-cli tests and the 401-gate api tests are deleted
with what they cover; the transcript route's existing api coverage gains
the cross-owner read case; any new CLI surface gets its e2e test. The
existing e2e topology is untouched by phases 0–2 and gains a
second-principal case in phase 3.

## Open questions

- **Header vs. `whois` ordering**: the header form ships first because it
  needs nothing in the pod; decide whether `whois` (device identity, tagged
  nodes, and the tailscaled socket mount in the server Deployment) lands
  with phase 1 or waits for the first request that needs device identity.
  Lean: with phase 1 — "revoke a device" has to have an answer the day
  tokens are gone.
- **Serve on self-requests**: whether `tailscale serve` adds identity
  headers to a node's requests to its own ts.net name. `tailscale-only`
  mode depends on it; verify on a real node before documenting the mode.
- **Attach-write semantics for handoff** (phase 4): whether write-attach
  is exclusive (owner or delegate) or advisory — decide when presence
  lands, not before.
- **tui transcript fidelity**: claude's JSONL replays into chat form
  today; codex/pi vary — per-tool structured rendering vs. the current
  `NOT_SUPPORTED` refusal.
- **Registry containment mechanism**: registry auth with per-project push
  scopes vs. digest-pinned consumption (the promoter records the digest a
  build produced and pods reference it, making stray tag writes inert).
  Lean digest-pinning — it needs no registry auth stack and the promoter
  already sits in the right place.
- **Team objects** (phase 4+): whether `owner` references a principal id
  that can name a team from day one, or users only until teams are real.
  Lean: principal id from day one, it costs a type.
- **Containerless installs with more than one human**: whether ownership
  should be offered there at all, given every workspace holds every
  credential it is handed. Lean: yes as organization (it is the same code),
  with the UI saying plainly that this substrate does not separate users.
