# Multi-user deployment: principals in the layered server

## Goal and trust model

Several teammates share one always-on yaac deployment. Each has their own
projects, workspaces, tool and git credentials, preferences and quota. Each
can see what every other user sees, read-only, by switching the sidebar to
that user. Later collaboration features (observable live sessions,
presence, handoff, comments, team projects) build on the same structure.

The trust boundary is the tailnet, as in docs/remote-hosting.md. Users are
teammates who trust each other and the host admin. Per-user separation is
organizational (own data, own credentials, own workspaces), not a defense
against a hostile teammate. The defense against hostile code stays where it
is today: the gVisor and egress sandbox around workspace pods.

Under the `k8s` driver a workspace holds sentinel credentials and the
egress proxy swaps in the real ones, so the deployment can decide per
workspace whose credential is spent. Under `containerless`
(docs/containerless-driver.md) every workspace is a tmux server running as
the server's OS user, with real tokens in its checkout, so nothing
separates one user's agent from another user's data. **Separation is a
`k8s` property.** The ownership code lives above the driver interface and
containerless runs it unchanged. It gets ownership as organization
(grouping, read-only views, attribution), and the UI says plainly that this
substrate does not separate users.

## Where this starts

Shipped:

- **Identity.** `identify()` in `packages/server/src/api/http/web-auth.ts`
  gives every request a `Principal`: `local` for a loopback request, or the
  `tailnet` user that `tailscale serve` (or the Tailscale operator's
  Ingress) stamped in `Tailscale-User-Login`/`-Name`. `GET /whoami` returns
  it. docs/remote-hosting.md "Security model" is the reference.
- **Transcript reading.** `GET /workspace/:id/agent-sessions` and
  `.../:sessionId/transcript` answer for stopped workspaces too, rendered by
  the SPA's `StoppedTranscript`. Sharing logs is a policy grant on an
  existing read path.
- **Per-workspace agent history** (`agentHistoryDir`), so a transcript's
  owner is its workspace's owner.
- **Precondition hardening**: exact workspace-id resolution, globally unique
  workspace ids, confined server I/O on sandbox-writable paths, immutable
  project ids, main-registry write grants (docs/trust-split-builds.md), and
  a read-only main clone (docs/server-git.md).

Nothing user-shaped is in the schema yet. Observed facts enter the database
only through `applyWorkspaceEvent`, and the substrate has no users in it, so
principals annotate intent (creates, writes), never observation. The event
union, the driver contract, `src/runtime` and `src/lib` stay user-free.

## The structural decision

**One server, with `Principal` as a value passed down the existing
layers.** Users partition the data, not the process. A process per user
would cost a facade at every call site and a back-channel for cross-user
reads, buying isolation the trust model does not ask for, and it dead-ends
at the first collaborative write. Every write a user can cause already goes
through a domain verb (docs/layered-server.md), so domain verbs are the
single place to authorize.

## Decisions

- **Projects are private.** A project has exactly one owner, and only the
  owner creates workspaces in it. Two users adding the same GitHub URL get
  two unrelated projects, each with its own clone, git credential and image
  chain.
- **Projects are keyed by uuid.** `projects.id` replaces the slug as the key
  everywhere (rows, data dir, routes, proxy registrations, secret refs,
  labels); the repo-derived `name` is display-only and not unique. This
  landed first, as its own change.
- **No admin role.** With private projects and per-user settings, the only
  shared writes left are retrying and dismissing builds of the shared images
  (base, tools, nestable, proxy, netd), which are harmless and open to every
  user. Install administration (upgrades, restarts, server env) happens
  through cluster or host access, outside the API.
- **Every tailnet user who reaches the server is a user**, created on first
  request. The tailnet ACL is the access list.
- **Per-user user Dockerfiles.** The final image layer is built from the
  project owner's `Dockerfile.user`.
- **The snapshot is not filtered.** It carries every row with its owner;
  per-audience field scoping is not needed under this trust model.
- **Prewarm cost is accepted**: the pool is per project, hence per owner.
- **The spawn budget reuses the per-workspace cap.**
- **Existing installs migrate** in place (see "Access modes" for how an
  install acquires its owner).

## Design

### Access modes

An install runs in exactly one access mode, recorded in its database and
checked on every start, so a forgotten env var cannot change who the server
admits.

| Mode | Admits | Users |
|---|---|---|
| `local` | loopback only; anything through `serve` is refused | one built-in user with no login, owning everything |
| `tailnet` | only `serve` with a tailnet identity; plain loopback is refused | created on first sight of a login |

- **A fresh install's mode** comes from the command that stands it up:
  `yaac cluster install` → `local`, `yaac cluster install --tailnet` →
  `tailnet`; `yaac server start` → `local`, `yaac server start --tailnet
  <host>` → `tailnet`. The containerless flag replaces exporting
  `YAAC_ALLOWED_HOSTS`, which remains only as the k8s Deployment's internal
  plumbing. Starting in a mode other than the recorded one is refused,
  naming the command that changes it.
- **`local` → `tailnet`** is one-way and needs `--owner <login>` on the same
  command. The flip gives the built-in user that login; since ownership
  references user ids, no other row changes. An upgraded install with data
  and no recorded mode counts as `local`, so a `--tailnet` start without
  `--owner` is refused. A fresh `tailnet` install has nothing to claim and
  needs no `--owner`.
- **`tailnet` → `local`** is refused.
- **How a start asks for a mode.** The server process reads the requested
  mode from `YAAC_ACCESS_MODE` and the owner from `YAAC_ACCESS_OWNER`
  (plumbing only: `yaac server start|restart --tailnet <host> --owner
  <login>` sets them on the detached child, `yaac cluster install` on the
  Deployment from its fronting). `settleAccessMode` (`src/main/access-mode.ts`)
  checks them against the `access_modes` row once the DB is open. A fresh
  install is one with no row; the migration records `local` for an upgraded
  install with data. `--owner` applies only on the switch to `tailnet` (or a
  fresh `tailnet` start) and is ignored after. A refused start keeps serving
  `/health` with `refused: <reason>` and nothing else; `yaac server start`
  prints it and stops the server, and `yaac cluster install` fails with it.
  `/health` also reports the settled `access` mode, which `yaac server
  start` compares with an already-running server's.
- **Exceptions to "no loopback in `tailnet` mode"**:
  - Under containerless, `POST /workspace/mama` still arrives over loopback
    with the workspace's bearer token. `identify()` lets that one route
    through without setting a principal, and the route authenticates the
    bearer. Its principal is the caller workspace's project owner
    (`projects.owner`), which the step threading principals into domain
    verbs resolves there. Under k8s, mama already arrives on its own relay
    listener.
  - A yaac server nested inside a workspace is its own install, always
    `local`, reached through the outer workspace's forward, which only that
    workspace's owner can open.

### Authorization

Domain verbs take the principal as an explicit argument; routes pass the
one `identify()` resolved. Internal callers (the reconcile loop, prewarm,
queued-workspace starts, the stale reaper, the title sweep) pass a `system`
principal that `identify()` never returns.

A sealed `domain/access` folder owns `authorize(principal, level,
resource)`, with two access levels:

- **`reader`**: any user, any resource. Workspace lists, details,
  transcripts, diffs, project pages.
- **`owner`**: the resource's owner only. Everything a user can change,
  and the reads that grant execution or reach: every `/pty/attach` target,
  `/acp/attach` (its `prompt`, `cancel` and `permission` frames),
  `/forward/attach` (a tunnel into the workspace's listeners, and into a
  nested yaac's full API). The attaches are GETs and WebSocket upgrades
  that change no rows, so they are classed by what they grant, not by
  their HTTP method.

The owner of a workspace, queued workspace, draft, group, agent session or
tool default is its project's owner; only `projects` and the user-scoped
tables carry an owner directly.

### Database

- A `users` table: uuid PK, unique `login` (null for the built-in `local`
  user), display name, first/last seen. The built-in user has the fixed id
  `BUILT_IN_USER_ID` (the nil uuid, exported by `#db`), so a `local`
  principal needs no lookup and internal callers can name it. `identify()`
  upserts a tailnet user through `seeTailnetUser`, cached per process and
  rewritten only for a new name or hourly, and `Principal` gains `userId`.
  `GET /whoami` answers `Whoami` (`Principal & { users: User[] }`); a
  `tailnet` install leaves a login-less built-in user out of `users`.
- `projects.owner` references `users.id`.
- User-scoped rows gain `owner`: `preferences` (git identity, time zone),
  `shortcut_overrides`, `git_credentials` (names unique per owner), and a new sealed
  `tool_credentials` table holding the tool bundles that live in
  `.credentials/<tool>.json` today. That move is a one-shot importer with a
  docs/legacy-compat-shims.md entry.
- Project env vars and secrets stay project-level; the project's owner is
  their owner.
- The stores take the owner's user id as their first argument (or a field,
  for `insertGitCredential`), with no authorization: routes pass
  `c.get('principal').userId`, and domain code that acts for a project (the
  create path, prewarm claims and staleness) passes `projects.owner`.
  `listGitCredentials()` with no owner lists every user's, for the
  install-wide runtime push and the git ssh agent.

### Credentials and the auth daemon

- `/auth/*` acts on the caller's own stores. `/auth/clear` with `service:
  all` clears only the caller's bundles; `/auth/list` lists only theirs.
- `authAgentHub` holds one daemon socket per user, and a connection can
  replace only its own user's socket. Login and install flows carry an
  owner and 404 for anyone else. This closes the OAuth-code takeover, where
  any user could evict the broker and receive a code another user pastes.
- Plan usage is looked up per user. The auth daemon seeds the connecting
  user's git identity, and a create is refused until the project owner has
  one.
- Host-side git fetches on a project's clone use the owner's credential,
  which they already do once projects are private.

### Egress proxy

Injection today resolves sentinels against one install-wide credential set:
any agent in any workspace may spend any credential the host has signed in.
Under ownership:

- The credentials Secret becomes a map from owner to `ProxyCredentials`,
  and `ProxyRegistration` carries the workspace's owner.
- Sentinel swaps, the OAuth refresh hold and write-back, the GitHub token
  pool and the ssh-agent's identities all resolve through that owner. A
  refresh in one user's workspace updates only that user's bundle.
- The `/tools` roster is filtered to the caller's owner.

`gitAuthFailures`, per-project registries, the build cache and the
user-layer repo are already keyed by project, hence by owner. Registry
repositories stay one per project and layer: builder-pod write grants are
scoped per repository (docs/trust-split-builds.md "The write gate"), so a
shared repository would let any builder overwrite any user's tags.

Under containerless, `#domain/auth`'s credential-sync works per project,
hence per owner, without change. That is bookkeeping, not separation.

### Spawning (`yaac-mama`)

Spawn policy already refuses another project, so a spawned workspace
inherits its caller's owner. Its tool resolves from that owner's
credentials, and the spawn fails if the owner has none. The in-flight cap
stays per workspace.

### Snapshot and SPA

- Snapshot rows carry their owner's user id; `GET /whoami` returns the
  caller and the user list.
- **The user switcher** (sidebar, `tailnet` mode only) filters the snapshot
  client-side to the chosen user: their projects, workspaces, groups, queued
  workspaces and drafts, laid out as their own sidebar shows them, with
  every control disabled. Their workspaces open in the transcript view.
  Project and workspace URLs name uuids, so a deep link to a teammate's
  workspace selects that user automatically.
- **Settings while viewing a teammate**: their project pages (config,
  Dockerfile, build files, env var names with secret values masked) show
  read-only. Personal settings (credentials, git identity, shortcuts) always
  show your own.
- **Read-only must not write.** Views that write as a side effect (opening a
  stopped workspace marks its death seen, the create form remembers choices)
  skip the write when viewing someone else. The server refuses these
  anyway; the SPA skipping them keeps errors off the screen.
- The live read-only chat view is deferred (issue #326); a teammate's
  running workspace opens in the transcript view, refreshed periodically.

### Image builds

- `/config/user-dockerfile` and `/config/user-build-files/*` become per user
  (`resolveRoot` in `api/routes/build-files.ts` takes the principal), and
  `yaac-user-<projectId>` is built from the project owner's file.
- Build rows for a project's chain are visible to everyone and retried or
  dismissed only by its owner; shared-image builds are open to every user.

## Work, in landing order

1. **Key projects by uuid** — shipped.
2. **Access modes** — shipped together with step 4: the recorded mode,
   `--tailnet`/`--owner` on `yaac server start|restart` and `yaac cluster
   install`, the refusals, the containerless mama loopback exception, the
   built-in `local` user.
3. **Principal plumbing**: `domain/access`, the `system` principal, domain
   verbs taking the principal, `owner` on the three attach upgrades. Every
   principal still resolves to the one owner, so behavior is unchanged.
4. **Users and owners** — shipped with step 2: the `users` table,
   `projects.owner`, per-user preferences, shortcuts and git credentials,
   with backfill to the built-in user.
5. **Per-user tool credentials**: the `tool_credentials` table and importer,
   caller-scoped `/auth/*`, the per-user auth daemon socket and flows, plan
   usage per user. The importer hands the bundles to the built-in user, which
   may have no login: an upgraded install whose only data was tool sign-ins
   counts as fresh, so it can go `tailnet` without `--owner`
   (docs/legacy-compat-shims.md "Backfilling owners and the access mode").
6. **Proxy keying**: the owner-keyed credentials Secret, owner on
   registrations, and every credential path resolving through it.
7. **Route authorization**: every route classified and gated, and per-user
   user Dockerfiles and build files.
8. **SPA**: owner on snapshot rows, the user switcher, read-only views,
   settings split, the containerless "does not separate users" notice.
9. **Docs**: a `docs/multi-user.md` reference and this plan deleted
   (remote-hosting.md's access modes, setup and security model sections are
   current).

## Testing

- `domain/access` gets its barrel-function tests.
- `test/api/route-matrix.ts` gains an `access` column (`public`, `reader`,
  `owner`), and a check drives every gated route as a second,
  non-owner principal and expects 403, so a new route cannot land without
  stating who may call it. A second principal is only request headers
  (`Tailscale-User-Login` with an allowed host).
- The transcript route gains the cross-owner read case.
- The access modes get api cases for each refusal and the `--owner` flip,
  and e2e-cli cases for the new flags.
- One two-user k8s e2e case, in an existing suite file: each user's
  workspace gets only its owner's credentials, and the second user can read
  the first's transcript.

## Deferred

- `whois` (tagged devices as callers, device revocation).
- Live read-only chat (issue #326) and terminal views; presence; handoff;
  comments.
- Team projects: `owner` naming a team, with roles.
