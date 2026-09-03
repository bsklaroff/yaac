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

## The structural decision, and the herd lesson

There are two ways to partition a system by user: give each user a process,
or give each row an owner. The herd split tried the first — a per-user
worktree/session manager behind a JSON-RPC seam — and its costs were exactly
the costs of a process boundary cut through a cohesive object model: a
facade at every call site, a link module for the back-channel, discovery and
lookup *inversions* (rows became reports, reads became pushed inputs), and
hand-maintained lint lists to hold the line. When the per-user-process
endgame was dropped, all of it was indirection with no payoff, and the
dissolution kept what was genuinely good — the layers, the one db door
for observed facts, the runtime driver contract.

So this plan takes the second way: **one server, and `Principal` as a value
that flows down the existing layers**. Users partition the data, not the
process. Process seams, when they come, should follow technical boundaries
(the session-operator plan's host-vs-cluster split), never organizational
ones.

What makes this cheap rather than invasive is a property the layered server
already has: **every write a user can cause flows through a domain mediator,
and the layers below domain never initiate intent.** Authorization needs
exactly one chokepoint, and domain verbs already are it.

## Facts that shape the design

- `tailscale serve` injects spoof-stripped `Tailscale-User-Login` /
  `Tailscale-User-Name` headers on proxied tailnet requests (Funnel traffic
  gets none) — identity with no login UI, no OAuth, no password store.
- The server today has no identity model: auth resolves "credential valid?"
  and drops everything (`packages/server/src/api/http/web-auth.ts`); nothing
  user-shaped exists in the schema. That absence is an asset — there is no
  wrong model to migrate off.
- Observed facts enter db through one door (`applyWorktreeEvent`), and
  the substrate has no users in it. So principals annotate **intent**, never
  observation — the event union, the runtime contract, and everything under
  `src/runtime`/`src/lib` stay user-free.
- There is no transcript-serving endpoint today: history reaches a client
  only over `/acp/attach` (running worktrees only); TUI history is tmux
  scrollback in the pod. The durable records exist on disk
  (`projects/<slug>/acp/<worktreeId>/<agentSessionId>.jsonl`, plus each
  tool's own JSONL), and `readAcpLog` parses them but has no route. This
  read path must be built under any architecture — and it doubles as
  "view logs of a stopped worktree", a missing single-user feature.
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
  tailscale serve → 127.0.0.1:8787       TLS + identity headers
  ONE yaac server                        principal-aware layered server
  one cluster, one namespace, one registry, one data dir, one DB
```

No gateway process, no routing, no per-user provisioning: `tailscale serve`
fronts the one server, and the server itself terminates identity.

### Identity terminates in `api/http`

The auth middleware grows one step: after the credential check, resolve a
`Principal`. Sources, in order:

- `YAAC_IDENTITY_HEADER=tailscale` (new env knob, read in
  `packages/shared/src/env.ts` like its siblings): trust
  `Tailscale-User-Login` as the principal. Safe under the same reasoning as
  `YAAC_TRUST_PROXY` — serve strips inbound copies, and only the proxy can
  reach the bind. Enabling it implies the credential gate as the existing
  remote knobs do; the `?token=` bootstrap and cookie exchange are simply
  never needed on this path (open the URL, you are you).
- A durable token row, which gains a `user` column — so CLI access (which
  also rides the tailnet and carries the header) and any non-tailscale
  deployment still resolve a principal from the credential itself.
- Neither configured (today's local install): the built-in owner principal.
  **Single-user is the degenerate case of multi-user, not a fork** — local
  installs run the same code with one implicit principal, so nothing about
  local development or the existing e2e topology changes.

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
endpoints. But the audit below establishes that **"read vs. write" is the
wrong axis to enforce on** — the real partition is three-way:

- **Genuine reads** (worktree list, detail, transcript tail, diff): safe to
  share, modulo the field-level secret leaks catalogued in the snapshot
  finding.
- **Action-shaped reads** — endpoints that look like reads but grant code
  execution: every `/pty/attach` target, and the `prompt`/`cancel` frames
  on `/acp/attach`. These are `act`, gated to the owner, never "read".
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
- `preferences` and `shortcut_overrides` become per-user rows (they are
  described today as "the user's" — now there are several).
- The event door is untouched. `WorktreeEvent` carries no principal;
  ownership is stamped when the *intent* row is created (the create verb),
  and discovery/observation continue to fill facts onto rows whose owner is
  already decided. This is the inversion the herd split had to fight for,
  already won and standing.

### Store: credentials and tool homes key by owner

Two moves, not one:

- Host-side credential bundles move from `.credentials/<tool>.json` to
  `.credentials/<user>/<tool>.json`. The auth-daemon flow already rides an
  authenticated connection, so the server knows which user's bundle is
  arriving. Per-user quota falls out: each user signs into their own
  Claude/Codex accounts.
- **Tool homes gain an owner segment.** Today `projects/<slug>/claude/`
  (and `codex/`, `pi/`, `opencode-config/`, plus `claude.json`) is mounted
  into *every* worktree pod of the project — settings, account state, and
  transcript files shared and mutually writable across whoever owns those
  worktrees. Per-(project, owner) tool homes (`projects/<slug>/<tool>/` →
  owner-keyed) make a pod mount only its owner's agent state, and put each
  transcript under its owner by construction — which is also what keeps
  "whose log is this" a path fact for the sharing feature. The
  `#runtime/agents` transcript locators and the project-relative path convention
  gain the segment; the phase-3 migration backfills existing dirs to the
  built-in owner.

The project repo clone (`projects/<slug>/repo`) stays shared across the
project's worktrees regardless of owner — that is the existing
multi-worktree trust class, and branch isolation is what already carries it.

### Runtime and platform: no user vocabulary

The runtime driver contract, the k8s driver, images, egress, terminals —
none of it learns that users exist. This is the load-bearing difference from
the herd split, which put the per-user seam *below* the object model and
dragged the whole bytes-and-runtime half through it.

Two mechanisms do become owner-keyed *through the worktree*, without the
runtime ever seeing a user: the pod spec mounts whichever tool-home and
credential paths the store staged for that worktree (the sanctioned
runtime-reads-store edge; a path change only), and the egress proxy's
credential machinery. The proxy piece is real work, not a relabel: today
injection is deliberately **not** keyed at all — the proxy resolves the
placeholder sentinels against one install-global bundle file per tool, and
its own comment states that "any agent in any worktree may now spend any
credential the host has signed in". The proxy already resolves every
request's source IP to a worktree registration (the attribution machinery
per docs/worktree-egress.md) and keeps per-worktree allowlists and
injection rules; the change is that a registration gains a credential-set
key, staged by the server from the worktree's owner, and every credential
path resolves through it: sentinel swaps, the GitHub token pool, and which
ssh-agent identities a worktree's connections may list and sign with
(today's gate checks only that the remote is SSH-shaped, not whose key it
is). The OAuth **refresh write-back** must route the same way — the proxy
captures Claude/Codex token-refresh responses and overwrites the stored
bundle, so today any worktree can rotate the credential every other
worktree uses; under ownership it writes back only to its owner's bundle.

### API surface

- The snapshot hub's `buildSnapshot()` becomes principal-aware only in what
  it *labels*, not what it hides: v1 policy is read-everything, so the
  snapshot gains owner fields for the UI to group by (mine vs. teammates),
  and per-principal filtering becomes a policy question for later, not a
  hub rewrite now.
- New transcript read endpoints (needed regardless):
  `GET /worktree/:id/agent-session/:sid/transcript` serving recorded
  conversations for running *or stopped* worktrees — ACP sessions via
  `readAcpLog` (route + barrel export; render-ready `AcpEvent[]`), tui-mode
  sessions via per-tool readers in `#runtime/agents` (claude JSONL
  first; codex/pi later; opencode leaves no host record — v1 shows its
  first-prompt metadata only).
- Write routes call `authorize` via their domain verbs; the PTY/ACP attach
  upgrades authorize as attach-read vs attach-write (a read-only PTY is the
  bridge's existing tee minus stdin).

### Frontend

Ownership-aware, not two apps: worktrees grouped mine-first with teammates'
visible read-only (no PTY input, no chat input, no lifecycle buttons —
driven by an `owned` flag on the snapshot rows), and a transcript pane that
feeds `WorktreeChat`'s rendering from the static endpoint instead of the
live socket. This is the roadmap's "shared / observable sessions" row
arriving as a view-mode rather than a separate surface.

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
- **The prewarm pool.** Spares take the normal create path, so their
  tool-home and credential mounts are fixed at spare creation and pods
  cannot be remounted — a spare is owner-bound the moment it exists. The
  pool becomes per-(project, owner), and claim filters by owner.
- **The global user Dockerfile** (`PUT /config/user-dockerfile`) is
  "applied as the top layer of every project image" — one user's edit runs
  in every user's future sandboxes. V1: admin-only (policy), keeping one
  image chain; per-owner top layers (and per-owner image chains, which the
  content-hash tags would absorb) only if personalization proves worth the
  build fan-out.
- Per-user UI/preference state that is install-global today and hence
  cross-user writable: default tool, shortcut overrides, worktree death
  read-marks (dismissing a death notice currently dismisses it for
  everyone).

**Changes scoping semantics** (today's scope is wrong for multi-user, and
two are dubious even single-user):

- **Proxied secrets are per-project, not per-owner.** The cross-*project*
  half is fixed: secrets are rows on the project, encrypted at rest, and a
  `secretRef` is scoped `<projectSlug>/<NAME>`, so one project's rule can no
  longer resolve another's value. What tenancy adds is the owner dimension
  where the value is user-supplied.
- **Persistent allow-host approvals fan out project-wide.** `persist:true`
  writes the host into the project config and widens every running sibling
  worktree — under ownership, that is a project *write* (owner/team-gated);
  non-owners get per-worktree, non-persistent approvals.
- **Builder pods can write any tag in the shared registry.** The
  unauthenticated `registry:2` accepts pushes to any `repo:tag` from
  builder pods running agent-authored Dockerfile `RUN` steps
  (docs/trust-split-builds.md states this open risk plainly). Single-user
  it is self-poisoning; multi-user it is one user's *agent* overwriting
  the image another user's next worktree boots. Containment (registry
  auth / per-project push scopes / digest-pinned consumption) graduates
  from "open risk" to a phase-3 prerequisite.

**Stays shared by design** (availability or teammate-trust class, named
rather than fixed):

- The single proxy pod and its install-global fate-sharing: MITM CA (one
  key transits everyone's traffic), DNS stub, leaf-cert cache, the spawn
  queue and ssh-agent connection caps (a busy worktree can starve
  siblings — a fairness knob to revisit, not a correctness hole), and the
  shared state files under `run/proxy-data/`. Attribution itself is
  sound: per-pod-IP filter chains with no default chain, node-CIDR-gated
  transparent ports, and the vcluster attribution map and relay token are
  server-authored only.
- The project repo clone, mounted read-write into every worktree pod of
  the project — the existing multi-worktree trust class; branch isolation
  carries it, and `git-auth-failures` records staying project-scoped
  matches it.
- Forwarded worktree ports bind the host and are tailnet-reachable
  ungated (the standing docs/remote-hosting.md caveat) — any tailnet user
  can reach any worktree's dev server. Unchanged trust class, now with
  more people behind it; a token-gated forward story is future work.

### Projects under ownership

Projects are the one resource where "read all, write own" is not enough of
an answer, because slugs are a global namespace and the clone is heavy.
Two coherent shapes:

- **Owner-private projects**: only the owner creates worktrees. Two users
  working the same repo either collide on the slug or duplicate the clone
  and the image chain.
- **Communal projects** (recommended): any authenticated user may create
  worktrees in any project — the worktree is owned by its creator; project
  *mutation* (config, Dockerfile, build files, delete) stays
  owner-gated. Creating a worktree in someone's project means running
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
public repos need none); proxy
HTTPS git and `gh` token selection draws from the owner's pool; the
ssh-agent serves only the owner's identities; and the pod's git author
identity is seeded from the owner, so agent commits attribute to the right
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
  on shared hostPaths** (`drivers/k8s/substrate/pod-spec.ts` `podUid()`; gVisor has
  no userns/idmap, so hostPath uids pass through raw). There is therefore
  **no filesystem-level isolation between worktrees** — owner separation
  can only come from *which paths get mounted*, never from permissions on a
  shared mount. Every "owner-key this dir" item below means mount-selection,
  and a shared-writable mount is a cross-user channel no policy check sees.
- **Read-all is unsafe until "read" is narrowed** (the three-way split
  above), because much of what looks like a read is either execution or a
  secret disclosure.

### Preconditions — pre-existing bugs that make ownership meaningless until fixed

These are exploitable in the *current* single-user server too; ownership
cannot be enforced on top of them.

- **Empty/prefix worktree-id resolution → a shell in an arbitrary pod.**
  `findWorktreePod` matches `worktreeId.startsWith(idOrName)`
  (`drivers/k8s/substrate/pods.ts`), and the PTY route defaults a missing id to `''`
  (`main/server-run.ts`), so `GET /pty/attach?id=&target=shell` resolves to
  *the first running pod in the cluster*. Every `/worktree/:id/*` route
  inherits the ambiguity through `domain/worktrees/resolve.ts`. **Fix
  first, before any owner lookup** — an owner check keyed off a fuzzy
  resolve targets the wrong row. Require exact/full-id match; reject empty.
- **`/repo/.git` is mounted read-write and is a server-host escape today.**
  Any worktree can write `hooks/`, `config` (`core.hooksPath`,
  `core.fsmonitor`, `core.pager`), or `refs/remotes/origin/*`; the server
  then shells `git`/`simple-git` against `repoDir(slug)` (fetch, default
  branch, skills `ls-tree`, diffs) and runs those hooks **on the host**.
  Harden regardless of tenancy: pin `GIT_CONFIG_GLOBAL`/`SYSTEM` and
  `core.hooksPath=/dev/null` on all server-side git, and prefer mounting
  `/repo/.git` read-only with only per-worktree `worktrees/<id>` writable.
- **`.cached-packages` lets one worktree write another's live
  `node_modules`.** The whole per-project pnpm store is mounted RW and the
  per-worktree ephemeral module backings live *inside* it
  (`modules/<worktreeId>/…`), so same-uid worktree A can write B's
  `node_modules` directly, and can poison the content-addressed store the
  next `pnpm install` hardlinks from. Mount only `<store>` plus the
  worktree's own `modules/<id>` slot; then owner-key the store root.
- **`cacheVolumes` keys are unvalidated → host path traversal.** The key is
  taken from project config and only the *value* is checked for
  absoluteness (`domain/projects/config.ts`); a key of `../../../.credentials`
  flows into `path.join` and is `mkdir`'d and mounted RW into the pod.
  Validate the key (`/^[A-Za-z0-9._-]{1,64}$/`) now; owner-key the dirs
  under tenancy.
- **`POST /auth/fake` is a test seam on the production API** with no env
  gate — it overwrites real credential files with synthetic ones. Gate on
  `testEnv` or remove from the HTTP surface.

### Action-takeover chains (multi-user)

- **`/agent/auth` socket hijack → OAuth code interception.** The WS handler
  `authAgentHub.setSocket(sock)` closes the incumbent auth-daemon socket and
  installs the caller's (`domain/auth/agent.ts`). Any authenticated user can
  evict the real login broker *and* become the recipient of the OAuth
  authorization code a victim pastes at `POST /auth/login/:id/input` — an
  account-takeover chain. The auth-daemon channel must be a **distinct,
  single-holder, non-user credential kind**, never satisfiable by a web
  session, and `/auth/login/:id/*` flow rows need an owner (404 for
  non-owners).
- **`/acp/attach` is not a log tail.** Its `{type:'prompt'}` frame calls
  `conversation.prompt(text)` and `{type:'cancel'}` cancels a turn
  (`runtime/agents/acp-bridge.ts`) — prompting an agent is code execution by
  proxy. Split at the bridge: transcript replay = `read`; prompt/cancel =
  `act` (owner). This is the exact seam the sharing feature needs anyway.
- **Every `/pty/attach` target is code execution, and no viewer mode
  exists.** `shell`/`native` are raw/tmux-prefixed shells; `agent` and
  `window:@<id>` reach a TUI or another user's dev-server window; the
  fallback for an unknown target is `agent`. `bridge()` unconditionally
  wires stdin and `signal`. A read-only viewer is real work
  (`runtime/terminals/pty-bridge.ts`): a `{readOnly}` path that drops binary
  and `signal` frames, skips the shared-window `resizeWindow` (a viewer's
  browser size otherwise moves the owner's pane), excludes `native`, and
  caps viewer tmux sessions per worktree. For v1, owner-only PTY plus the
  read-only ACP transcript pane is the safe subset; a live TUI viewer is a
  §2 "observable sessions" item, not free.
- **Forwarded ports are unauthenticated raw TCP into the pod, and nested
  yaac serves its full API uncredentialed.** Listeners bind
  `YAAC_FORWARD_BIND` (a tailnet IP) with no bearer/session/owner check, so
  any tailnet peer reaches every worktree's forwarded ports — including a
  nested yaac's control plane, which skips the credential gate whenever
  `env.nested` (`api/http/web-auth.ts`); the remaining Host/Origin/Fetch
  guards are anti-rebind/CSRF checks a non-browser client trivially passes.
  This equates "on the tailnet" with "is the owner" — false under
  multi-user. Disposition: drop `env.nested` from `isCredentialOptional`
  and inject a generated credential into the inner server at create; front
  forwarded ports with the server's auth (a per-worktree forward token) or
  bind-and-gate per owner; apply the click-to-forward `SENSITIVE_PORTS` /
  infra-range filters to config-declared `portForward` too (today only the
  click path is filtered, so `portForward: 9229` is honored).

### Install-global writes that need admin/owner gating

The audit found the "only the owner may write" rule has a large second
class — *install-global* writes any user can make today:

- **Credentials** (`api/routes/auth.ts`): `PUT /auth/git/credentials`
  wholesale-replaces the entire credential set (swap in your token for a
  victim's host pattern and their pushes go to you); `PUT /auth/:tool`
  overwrites the install Claude/Codex bundle; `POST /auth/clear` de-auths
  every agent. All must be per-user stores, agent pods mounting the owner's.
  `GET /auth/list` leaks the SSH private-key *path* and the full pattern
  inventory — caller-scope it.
- **Tokens** (`api/routes/tokens.ts`): `DELETE /tokens/:name` is an
  unscoped global logout (names are enumerable via `GET /tokens`, which
  lists every user's devices and browser sessions); the
  `MAX_WEB_SESSIONS`/`MAX_EXCHANGE_TOKENS` FIFO caps are global, so one user
  spamming `yaac open` evicts others' live sessions. Tokens need an
  `ownerId`; `isValidToken`/`isValidSession` must **return the principal**,
  not a boolean — that middleware signature (`web-auth.ts`) is the first
  thing to change, since the whole plan hangs off it; caps go per-owner.
- **Image/build surface**: `PUT /config/user-dockerfile` (top layer of
  *every* project image — highest blast radius), `/config/user-build-files/*`
  (same, and the shared `resolveRoot` signature can't express per-user until
  it takes the Principal), `PUT /project/:slug/dockerfile` and the
  `build-files` CRUD are all code-in-every-pod writes — admin or
  project-owner only. `POST /image/builds/:id/retry`
  can rebuild the shared egress-proxy sidecar (infra DoS) — admin.
- **Cross-boundary fan-out writes**: `allow-host` and `forward-port` with
  `persist:true` widen every running sibling worktree of the project (an
  egress/exposure channel into other users' agents); `mark-all-deaths-seen`
  and `POST /worktree/provisioning/:id/dismiss` write other users' rows;
  `DELETE /project/:slug` purges every worktree of the project. Owner/
  project-owner gated, with the provisioning registry gaining an owner
  field.
- **Shared preference rows**: `/tool/set` (also changes what prewarm warms)
  and `/shortcuts/*` are install-global — per-user rows (low severity, but
  reads like a bug).

### The spawn flow needs an owner carried through it

`yaac-mama` attribution is otherwise sound — the caller worktree is
resolved from source pod IP (not self-declared), project is taken from the
caller's pod labels, and a pod *cannot* spawn into another project
(`domain/worktrees/spawn-policy.ts`, `spawn-reconcile.ts`). Gaps under
tenancy: no owner is carried in `SpawnRequest`; the spawned worktree should
**inherit the caller's owner**, which means adding an `owner` pod label
(read on the same snapshot, so it can't race a deleted row) rather than a
store lookup. The per-caller spawn caps sit under an install-global
`SPAWN_MAX_PENDING_TOTAL` (one user starves the queue) — add a per-owner
budget. And `decideSpawn` falls back to the install-global default tool and
its credential — resolve tool *and* credential from the inherited owner, and
fail the spawn if the owner has no credential rather than creating an
unauthenticatable worktree. The proxy `/tools` roster leaks other users'
configured tools unless filtered by caller owner.

### Snapshot field leaks

`buildSnapshot` (`api/events.ts`) sends one payload to every connection, so
per-user filtering means giving up the single-serialization fast path (or
serializing per audience group). Fields that are per-user-sensitive even
under a generous read-all reading: `planUsage`/`codexPlanUsage` (the
credential owner's subscription tier and live quota — billing telemetry),
`gitAuthFailures` (which private hosts exist and whose token is broken),
provisioning `error`/`message` (repo URLs, paths), `projects[].remoteUrl`
(every user's private repo URLs), and `worktrees[].prompt` (the founding
user ask — free-form and the field most likely to surprise). The transcript
sharing feature wants worktrees/sessions readable, but these fields should
be owner-scoped in the snapshot from the start.

### Skills discovered from writable dirs are a cross-user injection path

Only the packaged builtin skills are mounted read-only per worktree (safe).
The *personal* skill tier is just the shared per-project tool home
(`claudeDir(slug)/skills`, etc.), writable by the agent: worktree A writes
`~/.claude/skills/foo/SKILL.md` and every later worktree in the project — any
owner — loads it into agent context, persisting past A's deletion. The
*project* tier reads `origin/<branch>` from the shared clone, forgeable via
the `/repo/.git` write hole above. Owner-keying the tool homes fixes the
personal tier for free; the UI should show skill provenance (which
owner/worktree last wrote it) and treat writable-dir skills as untrusted by
default. Title generation, by contrast, is **not** a quota surface — it runs
a local llama.cpp subprocess, no credential — so it only needs its sweep and
`attempted` set scoped by owner and `setWorktreeTitle` owner-gated.

## How the rest of roadmap §2 lands in this structure

Each next feature is rows + policy + UI in an existing layer — no new
processes, no new arrows:

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

- **Per-user server instances behind a routing gateway** (this plan's
  previous shape): a new gateway package routing on the identity header,
  one full server + data dir + namespace per user, a GET-allowlisted
  `/peer/` namespace for cross-user reads. Workable — coexisting installs
  on one cluster are an exercised pattern — but it needs real shared-host
  fixes (the fixed-name registry Deployment clobber, promoting
  `YAAC_K8S_NAMESPACE` from test hook, a known_hosts collision), N of
  everything (DBs, reconcile loops, informer sets, netd port trios), a
  privileged token store in the gateway, and it dead-ends exactly where
  the herd split did: every collaborative *write* feature (presence,
  handoff, comments) needs shared state with identified authors, which a
  router cannot own and N databases cannot share. Choosing it means
  choosing federation later.
- **One shared instance with no identity** (works today, zero code):
  everyone full-access on one server, log-sharing free. The right stopgap
  while phase 1 lands, but tool credentials and quota are per-install
  (everyone burns one account), and nothing distinguishes users — no
  ownership, no read-only, no §2 trajectory.
- **Reviving a per-user process seam** (herd-shaped, or one "session
  manager" per user under a shared API tier): re-buys the facade, the
  link, the inversions, and the lint walls, for isolation the trust model
  doesn't demand — teammates on a tailnet, with the real sandbox at the
  pod boundary.
- **A standalone read-only log-viewer** over the data dirs: least code
  touching yaac, but re-implements transcript rendering in a dead-end
  second UI and advances nothing else.

## Phasing

0. **Precondition hardening — ship now, independent of tenancy.** The
   audit's "preconditions" are live bugs in the single-user server:
   exact-match worktree-id resolution (reject empty/prefix), pin
   server-side git config + `core.hooksPath` and prefer a read-only
   `/repo/.git`, narrow the `.cached-packages` mount and validate
   `cacheVolumes` keys, and gate `POST /auth/fake` on `testEnv`. None of
   this needs a `Principal`; all of it is required before any owner check
   is meaningful.
1. **Principal plumbing, no behavior change.** The `Principal` type,
   `domain/access` with the `read`/`act`/`write`/`admin` action verbs
   (sealed, tested per convention), the middleware resolution *returning a
   principal from `isValidToken`/`isValidSession`* (the signature the whole
   plan hangs off), domain verb signatures take the principal, everything
   resolves to the built-in owner. Mechanical, revertible, and the layering
   rules make "every verb takes a principal" reviewable in one place.
2. **Transcript endpoints + stopped-worktree log viewing.** Route +
   `readAcpLog` export + claude reader + read-only transcript pane, with the
   `/acp/attach` bridge split into `read` replay vs. `act` prompt/cancel.
   Ships single-user value on its own.
3. **Users become real.** `users` table, `owner` columns + backfill
   migration, token `user` column, `YAAC_IDENTITY_HEADER`, per-user
   credential subtrees, owner-keyed tool homes (dir migration + the
   locator/path-convention change), the proxy's credential-set keying
   (injection, refresh write-back, git tokens, ssh-agent filtering),
   per-(project, owner) prewarm, the audit's scoping fixes
   (envSecretProxy, allow-host/forward-port persist, builder registry
   containment, admin-gated user Dockerfile + build-files, per-user
   preference rows), the credential/token/auth-daemon fixes (per-owner
   token store with per-owner caps, distinct daemon credential kind,
   owner-scoped `/auth/*`), the spawn owner label + per-owner budget,
   forwarded-port authn + dropping `env.nested` from
   `isCredentialOptional`, snapshot field scoping, owner-keyed skills,
   communal projects with owner-gated mutation and per-user git auth, the
   `act`-gating of PTY/ACP, and the ownership-aware UI.
   This phase is the multi-user deployment: serve the server, add users
   to the tailnet, done. Read-only log sharing arrives here as one `read`
   grant, not a feature bolted on the side.
4. **§2 features** — presence, handoff, comments — each as rows + policy +
   UI on the standing structure.

Testing per repo conventions: `domain/access` gets its barrel-function
tests; the api project covers principal resolution (header, token, local
default) and write-denial for non-owners; transcript endpoints get api
coverage including the stopped-worktree case; any new CLI surface gets its
e2e test. The existing e2e topology is untouched by phase 1–2 and gains a
second-principal case in phase 3.

## Open questions

- **Header trust hardening**: whether `YAAC_IDENTITY_HEADER` should also
  verify the peer is the local tailscaled (LocalAPI whois on the socket)
  or loopback-bind is sufficient given the single-OS-user host. Lean:
  loopback + the knob being explicit opt-in is enough for the trust model.
- **CLI identity without the header**: a non-tailscale remote deployment
  needs `yaac auth token create --user <login>`; decide whether minting
  stays admin-only (host CLI) or users mint their own once authenticated.
- **Attach-write semantics for handoff** (phase 4): whether write-attach
  is exclusive (owner or delegate) or advisory — decide when presence
  lands, not before.
- **tui transcript fidelity**: claude's JSONL parses into chat form;
  codex/pi vary — per-tool structured rendering vs. first-prompt-only in
  v1.
- **Registry containment mechanism**: registry auth with per-project push
  scopes vs. digest-pinned consumption (the promoter records the digest a
  build produced and pods reference it, making stray tag writes inert).
  Lean digest-pinning — it needs no registry auth stack and the promoter
  already sits in the right place.
- **Team objects** (phase 4+): whether `owner` references a principal id
  that can name a team from day one, or users only until teams are real.
  Lean: principal id from day one, it costs a type.
