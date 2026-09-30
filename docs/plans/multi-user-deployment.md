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
- The server already identifies every caller (docs/remote-hosting.md
  "Security model"): `identify()` in `packages/server/src/api/http/web-auth.ts`
  resolves a `Principal` — `local`, or the `tailnet` user `tailscale serve`
  stamped — and stores it on the request, where `GET /whoami` and the
  request log read it. Nothing user-shaped exists in the schema yet; the one
  non-server identity axis is per-worktree, not per-user
  (`worktrees.mamaTokenHash`, the bearer a containerless worktree presents to
  `POST /worktree/mama`). That absence is an asset — there is no wrong model
  to migrate off.
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
  `tui` claude conversation through `claudeTranscriptAsAcp`, refusing
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
env such as `YAAC_ALLOWED_HOSTS` reaches the pod by re-running `yaac cluster
install`.

### Identity terminates in `api/http`: loopback or tailscale, no tokens

Shipped; docs/remote-hosting.md "Security model" is the reference. Three
refinements of what this section first proposed:

- **No `YAAC_IDENTITY` knob.** The rule is derived from the request: a
  request `tailscale serve` forwarded is identified by the user it stamps,
  and one it did not forward is local only when it names a loopback `Host`.
  A knob could be left off on a fronted server; the Host rule fails closed.
- **No `tailscale-only` mode.** The fronting that would need it — the
  in-cluster tailnet Ingress — never presents a loopback Host.
- **The nested-server relaxation stays, narrowed.** Inside a worktree an
  unproxied request is local whatever its Host, because an inner server is
  reached as `srv.<tailnet>:<port>` through the outer install's forward;
  serve-proxied traffic to it is still identified.

Tagged devices carry no user and are refused until the `whois` form — the
tailscaled socket mounted into the server, resolving the forwarded address
to a node — admits them as node principals. That is also what "revoke a
device" rests on in phase 3.

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
  under the data dir, mirrored into each project's tool home. The server
  hands the proxy the whole set as a Secret on every write, and adopts the
  rotations the proxy captures from another Secret (docs/worktree-egress.md).
- Git credentials — HTTPS tokens and generated SSH keys — are named sealed
  rows (`git_credentials`), each assigned to projects
  (docs/git-credentials.md), handed to the proxy in that same Secret scoped
  by project, or to a containerless worktree's own agent. Project env and proxied secrets are sealed rows too
  (`project_env_vars`), handed to the proxy as one Secret of opened values
  per project — registrations carry only `secretRef`s.

Two moves, not one:

- Host-side credential bundles move from `.credentials/<tool>.json` to
  `.credentials/<user>/<tool>.json`. The
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
sign with (today the relay scopes them to the keys assigned to the
worktree's project, not to its owner). The OAuth **refresh
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
  cross-user writable: the per-project create memory (last agent and each
  agent's model, posture and UI), git identity, shortcut overrides, and
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
- **Builder pods write the shared registry under a per-project grant.**
  Every write to the main registry needs a signed grant naming the repos
  it covers, and a builder's names only the layer it builds and its
  project's step-cache repo (docs/trust-split-builds.md "The write gate").
  That closes cross-project writes, but not cross-user ones inside a
  communal project: `yaac-user-<id>` is built from each user's own
  `Dockerfile.user`, yet every user's builder may write it, and the image
  one user's agent pushes there is what another user's next worktree
  boots. Phase 3 keys the user-layer repo — and so its grant — by
  (project id, owner).
- **The per-project registries are a cross-user channel too.** They are
  not on the builder path, but they are written from *inside* worktree
  sandboxes (nested-image salvage), unauthenticated, by every worktree of
  the project, and the node image store materializes their contents into
  every nested worktree of the project — upstream names included. Within a
  communal project that is one user's agent choosing the images another
  user's nested worktree resolves locally. Phase 3 derives the registry
  name and store path from (project id, owner) rather than the project id.

**Stays shared by design** (availability or teammate-trust class, named
rather than fixed):

- The single proxy pod and its install-global fate-sharing: MITM CA (one
  key transits everyone's traffic), DNS stub, leaf-cert cache, the mama
  command queue (`MAMA_MAX_PENDING_TOTAL` across the install, with a
  per-worktree cap beside it) and ssh-agent connection caps (a busy
  worktree can starve siblings — a fairness knob to revisit, not a
  correctness hole), and the proxy's record ConfigMap, which is one object
  for the whole install.
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
  on shared hostPaths** (`installSecurityContext()` in
  `drivers/k8s/substrate/pod-spec.ts` stamps every pod with the install uid;
  gVisor has no userns/idmap, so hostPath uids pass through raw). There is
  therefore **no filesystem-level isolation between worktrees** — owner
  separation can only come from *which paths get mounted*, never from
  permissions on a shared mount. Every "owner-key this dir" item below means
  mount-selection, and a shared-writable mount is a cross-user channel no
  policy check sees. (Of the mounts `createWorktree` builds, only the
  attachments and the project's main clone are `readOnly`.)
- **Read-all is unsafe until "read" is narrowed** (the three-way split
  above), because much of what looks like a read is either execution or a
  secret disclosure.

### Preconditions — pre-existing bugs that make ownership meaningless until fixed

This one is exploitable in the *current* single-user server too; ownership
cannot be enforced on top of it. It is shipped for every project whose
last linked checkout has been converted (docs/server-git.md). The rest of
that list — exact worktree-id
resolution, the `.cached-packages` mount, `cacheVolumes` key traversal and
the ungated `POST /auth/fake` — has shipped.

- **The project's main clone was mounted read-write, so a worktree could
  point the server's git at other projects' files.** Each worktree is now a
  clone of its own, and pods mount the main clone read-only
  (docs/server-git.md). What remains is the upgrade window: until a
  project's last linked checkout from an older install is converted, a
  legacy pod still holds the main clone read-write
  (docs/legacy-compat-shims.md).

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
  unconditionally writes binary frames to stdin, honors `signal`, and every
  view resizes the shared window to its client (`window-size latest`
  follows whichever client last attached, resized or typed). A read-only viewer is real
  work (`runtime/terminals/pty-bridge.ts`): a `{readOnly}` path that drops
  binary and `signal` frames, keeps a viewer's resize off the shared
  window (a viewer's browser size otherwise moves the owner's pane), excludes
  `native`, and caps viewer tmux sessions per worktree. For v1, owner-only
  PTY plus the read-only transcript pane is the safe subset; a live TUI
  viewer is a §2 "observable sessions" item, not free.
- **`/forward/attach` is an identity-gated tunnel to any worktree's
  listeners, and a nested yaac serves its full API to whoever holds it.**
  The tunnel is identified, but every identified user can splice into
  every worktree's forwarded ports. A nested yaac treats every unproxied
  request as local (the `YAAC_WORKTREE_ID` relaxation in `identify()`);
  docs/remote-hosting.md argues this is fine because the inner server is
  reached only through the outer server's tunnel — which holds exactly as
  long as the tunnel is owner-gated.
  Disposition: `/forward/attach` authorizes `act` on the worktree, which
  closes both. A delegated tunnel (handoff, later) hands over the inner
  control plane with it, which is the trust class handoff means anyway —
  the delegate can already type into the agent. Separately, the port
  policy (`lib/port-policy.ts`) now refuses yaac's infra range in config
  `portForward` and on the k8s dial; a
  config-declared *sensitive* port such as 9229 is still honored on
  purpose, and the owner gate above is what limits who reaches it.

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
  spamming token mints evicts others' live sessions. The identity section
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
- **Shared preference rows**: the per-project create memory (also changes
  what prewarm warms), the git identity and `/shortcuts/*` are install-global
  — per-user rows
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
plus a per-worktree pending cap and `SPAWN_MAX_IN_FLIGHT_PER_WORKTREE` —
one user's worktrees can still fill the shared total, so add a per-owner
budget. And `decideSpawn` falls back to the project's last agent
(request tool → caller's tool → the project's last agent → `claude`) and its
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
the main clone, which no worktree can write once its project is converted.
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

0. **Precondition hardening — shipped, bar one.** Exact worktree-id
   resolution, the audit's other preconditions, globally unique worktree
   ids, server I/O confined on sandbox-writable paths, immutable project
   ids for everything named outside the data dir, and main-registry write
   grants have all shipped; the read-only main clone holds once each
   project's legacy linked checkouts are converted. None of it needs a
   `Principal`; all of it is required before any owner check is
   meaningful.
1. **Identity without tokens — shipped** (see "Identity terminates in
   `api/http`" above). The `whois` form follows.
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
   as project writes, owner-keyed user-layer repos and grants, admin-gated user
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
tests; the api project already covers principal resolution
(`identity-flow`), and gains write-denial for non-owners in both matrix columns — the header form needs
no tailscale, only request headers, and `whois` gets a stubbed LocalAPI;
the transcript route's existing api coverage gains
the cross-owner read case; any new CLI surface gets its e2e test. The
existing e2e topology is untouched by phases 0–2 and gains a
second-principal case in phase 3.

## Open questions

- **When `whois` lands**: it admits tagged devices and gives device
  identity; decide whether it waits for phase 3 or for the first install
  whose client is a tagged node.
- **Attach-write semantics for handoff** (phase 4): whether write-attach
  is exclusive (owner or delegate) or advisory — decide when presence
  lands, not before.
- **tui transcript fidelity**: claude's JSONL replays into chat form
  today; codex/pi vary — per-tool structured rendering vs. the current
  `NOT_SUPPORTED` refusal.
- **Team objects** (phase 4+): whether `owner` references a principal id
  that can name a team from day one, or users only until teams are real.
  Lean: principal id from day one, it costs a type.
- **Containerless installs with more than one human**: whether ownership
  should be offered there at all, given every workspace holds every
  credential it is handed. Lean: yes as organization (it is the same code),
  with the UI saying plainly that this substrate does not separate users.
