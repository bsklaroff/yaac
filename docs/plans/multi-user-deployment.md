# Multi-user deployment: principals in the layered server

## Goal and trust model

Several teammates share one always-on yaac deployment. Each has their own
projects, workspaces, tool credentials and quota. The first cross-user
feature is read-only access to each other's session logs (agent
conversation transcripts, in docs/naming.md terms). Later collaboration
features build on the same structure: observable live sessions, presence,
handoff, comments and team projects.

The trust boundary is the tailnet, as in docs/remote-hosting.md. Users are
teammates who trust each other and the host admin. Per-user separation is
organizational (own data, own credentials, own workspaces), not a defense
against a hostile teammate. The defense against hostile code stays where it
is today: the gVisor and egress sandbox around workspace pods.

That fixes the substrate. Under the `k8s` driver a workspace holds sentinel
credentials and the egress proxy swaps in the real ones, so the deployment
can decide per workspace whose credential is spent. Under `containerless`
(docs/containerless-driver.md) every workspace is a tmux server running as
the server's OS user, with real tokens in its checkout. Nothing separates
one user's agent from another user's data or from the host. **The
multi-user deployment is a `k8s` deployment.** The principal code lives
above the driver interface, so a containerless install runs it too and
gets ownership as organization (grouping, read-only views, attribution),
but not credential or filesystem separation.

## Where this starts

Shipped, and what this plan builds on:

- **Identity.** `identify()` in `packages/server/src/api/http/web-auth.ts`
  gives every request a `Principal`: `local` for a loopback request, or the
  `tailnet` user that `tailscale serve` (or the Tailscale operator's
  Ingress) stamped in `Tailscale-User-Login`/`-Name`. There are no tokens,
  no `YAAC_IDENTITY` knob and no login UI. A forwarded request with no user
  (a tagged device, Funnel) is refused. Inside a workspace
  (`YAAC_WORKSPACE_ID` set) an unproxied request is local whatever its Host,
  because a nested server is reached through the outer install's forward.
  `GET /whoami` returns the principal. docs/remote-hosting.md "Security
  model" is the reference.
- **Transcript reading, single-user.** `GET /workspace/:id/agent-sessions`
  and `GET /workspace/:id/agent-sessions/:sessionId/transcript` resolve the
  workspace row, so a stopped workspace answers. `getAgentSessionTranscript`
  (`#domain/workspaces`) replays an `acp` conversation's record
  (`projects/<slug>/acp/<workspaceId>/<agentSessionId>.jsonl`) and a `tui`
  claude conversation through `claudeTranscriptAsAcp`. Other tools get
  `NOT_SUPPORTED`, files over 64 MB get `TOO_LARGE`. The SPA's
  `StoppedTranscript` renders it through the same `AcpTranscript` component
  as the live chat pane. Sharing logs is therefore a policy grant on an
  existing read path.
- **Per-workspace agent history.** Each workspace's conversation files live
  in `projects/<slug>/history/<workspaceId>/<part>` (`agentHistoryDir`),
  mounted over the shared tool homes in a pod and linked into them on a
  host (docs/workspace-storage.md). A transcript's owner is therefore
  already its workspace's owner.
- **Preconditions from an earlier audit**: exact workspace-id resolution,
  globally unique workspace ids, confined server I/O on sandbox-writable
  paths, immutable project ids for names outside the data dir, main-registry
  write grants (docs/trust-split-builds.md "The write gate"), and a
  read-only main clone (docs/server-git.md). The last holds for a project
  once its legacy linked checkouts are converted
  (docs/legacy-compat-shims.md "Converting linked checkouts").

Not there yet: nothing user-shaped is in the schema. The only non-server
identity is per-workspace (`workspaces.mamaTokenHash`, the bearer a
containerless workspace presents to `POST /workspace/mama`). That is an
advantage: there is no wrong model to migrate off.

Other facts that shape the design:

- Observed facts enter the database only through `applyWorkspaceEvent`,
  and the substrate has no users in it. So principals annotate intent
  (creates, writes), never observation. The event union, the driver
  contract, `src/runtime` and `src/lib` stay user-free.
- `/acp/attach` is not a read path. It needs a live conversation, and every
  connection can send `prompt`, `cancel` and `permission` frames.
- Port forwards bind nothing on the server (docs/port-forward-tunnel.md). A
  client holds the listener and opens one `GET /forward/attach` WebSocket
  per TCP connection.
- The SPA is same-origin only, which one shared origin satisfies.
- PGlite is an embedded single-writer database, so one server process keeps
  it as it is.

## The structural decision

A system can be partitioned by user in two ways: a process per user, or an
owner on each row. A process boundary cut through one object model costs a
facade at every call site, a back-channel for cross-user reads, and lint
rules to hold the line. That only pays off if the goal is real per-user
isolation, which the trust model does not ask for.

So: **one server, with `Principal` as a value passed down the existing
layers.** Users partition the data, not the process. If process splits come
later, they should follow technical boundaries (host vs. cluster, as in
docs/plans/session-operator.md), not organizational ones.

This is cheap because of how the server is layered (docs/layered-server.md):
every write a user can cause goes through a domain verb, and the layers
below domain never start an action on their own. Domain verbs are already
the single place to authorize.

## Design

### Deployment

```
TAILNET
  alice, bob, carol ── https://yaac.<tailnet>.ts.net ── browser, CLI, phone
                              │
CLUSTER                       ▼
  Tailscale operator Ingress (TLS + identity headers)
      → yaac-server Service → the server pod
  one server, one namespace, one registry, one data dir, one database
```

`yaac cluster install --tailnet` sets this up (docs/server-in-cluster.md
"Reachability"). There is no gateway and no per-user provisioning. The
server resolves identity itself.

Tagged devices carry no user and stay refused until a `whois` lookup exists:
the tailscaled socket mounted into the server, resolving the forwarded
address to a node, admitting it as a node principal. Device revocation in
phase 3 rests on the same lookup.

### Principals are passed as arguments

Domain verbs take the principal as an explicit argument. There is no ambient
request context. Routes stay thin and pass the principal the `identify()`
middleware resolved.

A new sealed domain folder, `domain/access`, owns the `Principal` type, the
action names and `authorize(principal, action, resource)`, keeping policy in
one place like `spawn-policy`. The v1 policy is: any authenticated user may
read anything, only the owner may write.

"Read vs. write" is the wrong split to enforce, though. The audit below
shows three classes:

- **Genuine reads** (workspace list, detail, transcript, diff). Safe to
  share, apart from the snapshot fields listed under "Snapshot field leaks".
- **Reads that grant execution or reach**: every `/pty/attach` target, the
  write frames on `/acp/attach`, and `/forward/attach` (a tunnel into the
  workspace's listeners). These are `act`, owner-only.
- **Writes**, split into own-resource (owner-gated) and install-global
  (admin-gated). The second class is large and unguarded today.

So `authorize` takes a verb, `read` / `act` / `write` / `admin`. Log
sharing is the one cross-owner `read` grant, on the transcript route.

### Database

- A `users` table (login, display name, first/last seen), and an `owner`
  column on `projects` and `workspaces`, backfilled to a built-in owner by
  migration. Make `owner` a principal reference, not a login string, so it
  can later name a team.
- The other intent rows gain an owner the same way: `workspace_groups`,
  `queued_workspaces`, `draft_workspaces`.
- Per-user rows for what is install-global today: `preferences` (including
  the git identity, `git_user_name`/`git_user_email`, which decides what
  every workspace commits as), `shortcut_overrides`, and
  `project_tool_defaults` (the create form's per-project memory of agent,
  model, posture and UI, which also decides what prewarm warms).
- The event path is unchanged. `WorkspaceEvent` carries no principal. The
  create verb stamps the owner, and observation fills facts onto rows whose
  owner is already set.

### Credentials and tool homes

Where they live today:

- Tool OAuth/API-key bundles are files under the server-local
  `.credentials/` dir (`claude.json`, `codex.json`, `opencode.json`,
  `pi.json`), mirrored into each project's tool home. The server hands the
  proxy the whole set as a Secret on every change and adopts token
  rotations the proxy captures (docs/workspace-egress.md).
- Git credentials (HTTPS tokens, generated SSH keys) are sealed
  `git_credentials` rows assigned to projects (docs/git-credentials.md).
  Project env vars and proxied secrets are sealed `project_env_vars` rows.

Two changes:

- **Bundles move to `.credentials/<user>/<tool>.json`**, and the sealed-row
  stores gain an `owner` column. The auth daemon already rides an identified
  connection, so the server knows whose bundle is arriving. Per-user quota
  follows: each user signs into their own accounts.
- **Tool homes gain an owner segment.** `projects/<slug>/claude/` (and
  `codex/`, `pi/`, `opencode-config/`) is mounted read-write into every pod
  of the project: settings, account state, auto-memory and personal skills,
  shared and writable across owners. Per-(project, owner) homes make a pod
  mount only its owner's. Conversation history is already per-workspace, so
  it needs no change. The containerless link set gains the segment, and the
  phase-3 migration moves existing dirs to the built-in owner.

The project repo clone stays shared across owners. That is the existing
multi-workspace trust class, carried by branch isolation.

### Runtime and proxy

The driver contract, the k8s driver, images, egress and terminals do not
learn that users exist. A driver is handed paths and intents, never a
lookup, which is the shape ownership needs. Two things become owner-keyed
through the workspace without the runtime seeing a user:

- The pod spec mounts whichever tool-home and credential paths were staged
  for that workspace. This is only a path change.
- The egress proxy's credentials. This is real work. Today injection is
  deliberately not keyed: the proxy resolves sentinels against one
  install-global credential set, and its own comment says "any agent in any
  workspace may now spend any credential the host has signed in". The proxy
  already maps each request's source IP to a workspace registration. A
  registration gains a credential-set key, staged by the server from the
  workspace's owner, and every credential path resolves through it:
  sentinel swaps, the GitHub token pool, and which ssh-agent identities a
  connection may use (scoped today to the project's assigned keys). OAuth
  refresh write-back routes the same way. Today any workspace's refresh
  overwrites the bundle every other workspace uses; under ownership it
  writes only to its owner's.

Under `containerless` the equivalent is `#domain/auth`'s credential-sync,
which copies refreshed bundles between a project's tool home and the host
store. With owner-keyed homes and bundles it works per (project, owner)
without change. That is bookkeeping, not separation: the workspace holds the
real token either way.

### API and frontend

- `buildSnapshot()` (`api/events.ts`) gains owner fields for the UI to group
  by. It does not filter rows in v1, apart from the fields listed under
  "Snapshot field leaks".
- The transcript route is the shared read. `authorize(read)` on it is the
  whole sharing feature.
- Write routes authorize through their domain verbs. The PTY, ACP and
  forward attach upgrades authorize `act`.
- The SPA groups workspaces mine-first and shows teammates' read-only: no
  PTY input, no chat input, no lifecycle buttons, driven by an `owned` flag
  on snapshot rows. A teammate's running workspace opens in the existing
  transcript view. A live read-only view is a later feature (below).

## Shared-surface audit

Every place where one user's action could change state another user's
workspaces consume, and what to do about it. Findings come from a sweep of
the HTTP/WS routes, the pod layer and `k8s/proxy/proxy.ts`.

Two facts frame all of it:

- **Every workspace pod runs as the same uid, with passwordless sudo, on
  shared hostPaths** (`installSecurityContext()` in
  `drivers/k8s/substrate/pod-spec.ts`; gVisor has no user-namespace
  mapping, so hostPath uids pass through). There is no filesystem isolation
  between workspaces. Owner separation can only come from which paths get
  mounted. Of the mounts `createWorkspace` builds, only the main clone's
  `.git` and the attachments dir are read-only.
- **Read-all is unsafe until "read" is narrowed** to the genuine reads
  above, because much of what looks like a read is execution or leaks a
  secret.

### Execution disguised as reads

- **`/agent/auth` socket takeover.** `authAgentHub.setSocket` (in
  `domain/auth/agent.ts`) closes the current auth-daemon socket and installs
  the caller's. Any user can evict the real login broker and receive the
  OAuth code a victim pastes at `POST /auth/login/:id/input`: an account
  takeover. Fix: one daemon socket per principal, a connection can replace
  only its own user's daemon, and `/auth/login/:id/*` and
  `/auth/install/:id/*` flows carry an owner (404 for others).
- **`/acp/attach`** handles `prompt`, `cancel` and `permission` frames
  (`runtime/agents/acp-bridge.ts`). Prompting an agent, and answering its
  permission asks, is code execution by proxy. It is `act`, owner-only.
  Replay goes through the HTTP transcript route.
- **`/pty/attach`**: every target is code execution. `parsePtyTarget`
  (`runtime/terminals/pty-bridge.ts`) yields `shell`, `native`, `agent` or
  `window:<id>`, and falls back to `agent`. The bridge always forwards input
  and `signal` frames, and every viewer resizes the shared window
  (`window-size latest`). A read-only viewer needs its own path: drop input
  and signals, keep the viewer's size off the shared window, exclude
  `native`, cap viewer sessions per workspace. v1 is owner-only PTY plus the
  read-only transcript pane.
- **`/forward/attach`** lets any identified user splice into any workspace's
  forwarded ports. A nested yaac treats every unproxied request as local, so
  holding the tunnel means holding the nested server's full API
  (docs/remote-hosting.md relies on the tunnel being the only way in).
  Authorizing `act` on the workspace closes both. `lib/port-policy.ts`
  already refuses yaac's own infra ports; a config-declared sensitive port
  such as 9229 is honored on purpose, and the owner gate limits who
  reaches it.

### Install-global writes any user can make today

- **Credentials** (`api/routes/auth.ts`). `PUT /auth/:tool` overwrites the
  install's bundle and every project's mirror. `POST /auth/clear` with
  `service: all` wipes all four tool bundles. `POST
  /auth/git/credentials`, `/git/ssh-keys`, and the `PATCH`, `/replace` and
  `DELETE` routes on `/auth/git/credentials/:id` act on the one shared
  credential set; replacing someone's token redirects their pushes. `GET
  /auth/list` masks key material but returns the full inventory. All become
  per-user stores, caller-scoped.
- **Image and build inputs.** `PUT /config/user-dockerfile` is the top layer
  of every project image, the widest blast radius.
  `/config/user-build-files/*` is the same (`resolveRoot` in
  `api/routes/build-files.ts` needs the principal to express per-user).
  `PUT /project/:slug/dockerfile` and the project `build-files` routes put
  code in every pod of the project. v1: admin or project owner only, one
  image chain. Per-owner top layers only if personalization proves worth the
  extra builds. `POST /image/builds/:id/retry` can rebuild the egress-proxy
  sidecar: admin only. (All of these answer `NOT_SUPPORTED` under
  containerless.)
- **Fan-out writes.** `allow-host` and `forward-port` with `persist: true`
  write the project config and pass `fanOutToProject` to the driver,
  widening every running sibling workspace. Under ownership that is a
  project write; non-owners get per-workspace, non-persistent approvals.
  `PUT /project/:slug/env` reaches every future workspace of the project.
  `DELETE /project/:slug` purges all its workspaces.
- **Other users' rows.** `mark-all-deaths-seen` clears `deathSeen` for
  everyone's stopped workspaces; `POST /workspace/provisioning/:id/dismiss`
  dismisses anyone's provisioning entry (the registry gains an owner).
- **Shared preferences**: the git identity (`/config/git-identity`),
  `/shortcuts/*` and the create-form memory. Per-user rows, per the database
  section.

### Scoping that has to change

- **Prewarm.** Spares take the normal create path (`prewarm-reconcile` calls
  `createWorkspace` with `prewarm: true`), so their mounts are fixed when
  the spare is created and a spare is owner-bound from birth. The pool
  (`computePrewarmPlan`, `YAAC_PREWARM_POOL_SIZE` per project) becomes
  per-(project, owner), and claiming filters by owner.
- **Proxied secrets** are scoped `<projectSlug>/<NAME>`, which already
  blocks cross-project reads. Tenancy adds the owner where the value is
  user-supplied.
- **The user-layer image repo.** Builder pods write the main registry under
  a grant naming only their layer and their project's step-cache repo. That
  blocks cross-project writes, not cross-user ones: `yaac-user-<id>` is
  built from each user's `Dockerfile.user`, yet every user's builder may
  write it, and what one user pushes there is what another's next workspace
  boots. Key that repo and its grant by (project id, owner).
- **Per-project registries.** Workspaces push their built and pulled images
  into the project's registry from inside the sandbox (the image-cache
  salvage, docs/nested-containers.md), and the node image store serves them
  to every nested workspace of the project. Within a shared project, one
  user's agent chooses the images another's workspace resolves locally.
  Derive the registry name and store path from (project id, owner).
- **`git-auth-failures`** proxy records are keyed per project and cleared by
  any workspace's success. Key them per (project, owner) so one user's valid
  token does not hide another's expired one.

### Stays shared by design

- The one proxy pod: its MITM CA, DNS stub, leaf-cert cache, record
  ConfigMap, the mama queue cap (`MAMA_MAX_PENDING_TOTAL`, beside
  `MAMA_MAX_PENDING_PER_WORKSPACE`), and ssh-agent connection caps. A busy
  workspace can starve siblings; that is a fairness knob, not a correctness
  hole. Attribution itself is sound: source IP maps to workspace through the
  pod watch, and netd identifies traffic by the veth it arrives on
  (docs/workspace-egress.md).
- The project repo clone, per the credentials section.
- Whatever a client binds: `yaac forward --bind <tailnet ip>` exposes a
  workspace port to the whole tailnet. That is the forwarding user's choice
  about their own machine. The server side, `/forward/attach`, is
  `act`-gated.

### Spawning (`yaac-mama`)

Attribution is sound. Under k8s the proxy resolves the caller from its pod
IP; under containerless the workspace presents its per-workspace bearer.
Both reach `runMamaCommand`, and `spawn-policy.ts` stops a workspace
spawning into another project. Gaps under tenancy:

- `SpawnRequest` carries no owner. A spawned workspace inherits its
  caller's owner, read from the caller's row the drain already resolves.
- The caps are install-wide (`MAMA_MAX_PENDING_TOTAL`) and per-workspace
  (`SPAWN_MAX_IN_FLIGHT_PER_WORKSPACE`). Add a per-owner budget.
- `decideSpawn` falls back request tool → caller's tool → project's last
  agent → `claude`. Resolve tool and credential from the inherited owner,
  and fail the spawn if that owner has no credential.
- The proxy's `/tools` roster shows every configured tool. Filter by the
  caller's owner.

### Snapshot field leaks

`buildSnapshot` serializes one payload for every connection, so per-user
fields mean giving up that single serialization (or serializing per
audience). Owner-scope these from the start: `planUsage`/`codexPlanUsage`
(the credential owner's plan and live quota), `gitAuthFailures` (private
hosts and whose token broke), provisioning errors and messages (repo URLs,
paths), `projects[].remoteUrl`, and `workspaces[].prompt` (the user's
founding ask).

### Skills from writable dirs

Builtin skills are delivered read-only. Personal skills are read from the
shared tool home (`claudeDir(slug)/skills` and the other tools' equivalents
in `domain/skills/discover.ts`), which agents can write. Workspace A writes
`~/.claude/skills/foo/SKILL.md` and every later workspace in the project, of
any owner, loads it. Owner-keyed tool homes fix this. The UI should also
show which workspace last wrote a skill. Project skills are read from the
main clone's `origin/<branch>`, which no workspace can write.

Title generation is not a quota surface (it runs local llama.cpp, no
credential). It only needs its sweep scoped by owner and
`setWorkspaceTitle` owner-gated.

### Projects under ownership

Slugs are one global namespace and the clone is heavy, so "read all, write
own" does not settle projects. Two options:

- **Owner-private projects**: only the owner creates workspaces. Two users
  on one repo collide on the slug or duplicate the clone and image chain.
- **Shared projects** (recommended): anyone may create workspaces in any
  project, owned by whoever creates them. Changing the project (config, env
  and secrets, Dockerfile, build files, delete) stays owner-gated. Creating
  a workspace there means running the owner's config and image, the same
  trust as sharing the repo. Project delete is blocked (or needs force)
  while others' workspaces exist.

Git authentication stays per-user, which is what makes shared projects
safe. The git host's per-user permissions are the one real external access
control, so every git operation uses the requesting user's credential:

- Host-side fetches on the shared clone (create, restart, base-branch
  resolution) use the workspace creator's credential. Create always runs
  `fetchOrigin` and fails on a fetch error, so a private-repo create is
  already an access check for its creator.
- Proxy HTTPS git and `gh` tokens come from the owner's pool, and the
  ssh-agent serves only the owner's keys.
- The pod's git author identity comes from the owner's preferences.

Consequence: the shared clone caches objects across users, so once anyone
has fetched a repo, its contents are readable by the team. A repo some
teammates must not read does not belong on a shared deployment until
per-project visibility exists.

## Later features on this structure

Each is rows plus policy plus UI in an existing layer:

- **Observable sessions**: a read-only ACP socket (replay, no write frames)
  and the read-only PTY path above, each a `read` grant.
- **Presence**: the api layer already owns connections; a registry of
  attached principals feeds the snapshot.
- **Handoff**: a domain verb that changes attachment or ownership under
  `authorize`. The PTY bridge already serves several clients.
- **Comments**: a table with an author column and a read policy.
- **Team projects**: `owner` names a team, and policy gains roles.
- **Scaling execution**, if one process is ever not enough, is
  docs/plans/session-operator.md, a technical split that works with
  per-row ownership.

## Alternatives considered

- **Per-user servers behind a routing gateway.** One server, data dir and
  namespace per user, plus a gateway routing on the identity header and a
  read-only peer namespace for cross-user reads. Workable (several installs
  already coexist on one cluster), but it needs shared-host fixes (the
  fixed-name main registry Service, making `YAAC_K8S_NAMESPACE` more than a
  test hook), N copies of everything, and a gateway every instance trusts.
  It dead-ends at the first collaborative write: presence, handoff and
  comments need shared state with identified authors.
- **One shared server with no identity** (works today). Everyone has full
  access and log sharing is free. A fine stopgap, but everyone spends one
  set of credentials and nothing tells users apart.
- **A per-user process under a shared API tier.** All the cost of the
  process split for isolation the trust model does not need.
- **A standalone log viewer** over the data dir. Duplicates transcript
  rendering in a second UI and advances nothing else.

## Phasing

0. **Precondition hardening** — shipped (see "Where this starts").
1. **Identity without tokens** — shipped. `whois` follows.
2. **Principal plumbing, no behavior change.** `domain/access` with the four
   verbs (sealed, tested per convention). Domain verbs take the principal;
   the three attach upgrades authorize `act`; everything resolves to the
   built-in owner. Mechanical and revertible.
3. **Users become real.** The `users` table and owner columns with backfill;
   per-user credential dirs and owner columns on the sealed stores;
   owner-keyed tool homes; the proxy's credential-set keying (injection,
   refresh write-back, git tokens, ssh-agent); per-owner prewarm; the
   audit's scoping fixes and admin gates; per-principal auth daemon and
   owner-scoped `/auth/*`; spawn owner inheritance and budget; snapshot
   field scoping; shared projects with per-user git auth; the
   ownership-aware UI. After this phase, a multi-user deployment is: serve
   the server, add users to the tailnet. Log sharing is one `read` grant on
   the transcript route.
4. **Collaboration features** as listed above.

Testing: `domain/access` gets its barrel-function tests. The api project
already covers principal resolution (`identity-flow`) and gains non-owner
write denial in both route-matrix columns; the header form needs only
request headers, and `whois` gets a stubbed LocalAPI. The transcript route
gains the cross-owner read case. New CLI surface gets e2e tests. Phase 3
adds a second-principal e2e case.

## Open questions

- **When `whois` lands**: with phase 3, or when the first install needs a
  tagged-node client.
- **Handoff write semantics**: exclusive (owner or delegate) or advisory.
  Decide with presence.
- **tui transcripts for codex and pi**: per-tool rendering, or keep the
  `NOT_SUPPORTED` refusal.
- **Team owners**: `owner` as a principal id from day one (lean yes; it
  costs a type).
- **Containerless with several humans**: offer ownership at all? Lean yes,
  as organization (same code), with the UI saying plainly that this
  substrate does not separate users.
