# Multi-user installs

Several teammates can share one always-on yaac install. Each has their own
projects, workspaces, tool and git credentials, preferences and
`Dockerfile.user`. Each can also see everything every other user has,
read-only, by picking that user in the sidebar's user switcher.

How the server identifies callers, and the access modes that decide who it
admits, are in docs/remote-hosting.md ("Access modes", "Security model").
This doc covers what happens once a request has a user.

## Trust model

The tailnet is the trust boundary. Users are teammates who trust each other
and the host admin, so per-user separation is organizational (own data, own
credentials, own workspaces), not a defense against a hostile teammate. The
defense against hostile code is the gVisor and egress sandbox around
workspace pods.

**Separation is a `k8s` property.** Under `k8s` a workspace holds sentinel
credentials and the egress proxy swaps in its owner's real ones, so a
user's agent never sees another user's tokens. Under `containerless`
(docs/containerless-driver.md) every workspace is a tmux server running as
the server's OS user, with real tokens in its checkout. Any workspace,
like any process on the host, can therefore read every user's data, and
can also **act as** any user: a request to the server's loopback port that
carries `Tailscale-User-Login` is taken as coming through serve, so a
forged login gets that user's writes and attaches. The ownership code
runs unchanged there and gives grouping, read-only views and attribution,
not protection; the webapp says that this substrate does not separate
users. Under `k8s` only the host can forge those headers, since workspace
pods cannot reach the server.

## Users and owners

- **Users.** The `users` table has one row per tailnet login, written by
  `identify()` on first sight (`seeTailnetUser`, at most hourly after), plus
  the built-in user with the fixed id `BUILT_IN_USER_ID` (the nil uuid).
  A `local` install's caller is always the built-in user, which has no
  login until a switch to `tailnet` with `--owner` gives it one. `GET
  /whoami` answers the caller and the install's users; a `tailnet` install
  leaves a login-less built-in user out of the list.
- **One server, one principal per request.** Users partition the data, not
  the process. The request's `Principal` (with its `userId`) is passed down
  as an argument; the event union, the driver contract, `src/runtime` and
  `src/lib` know nothing about users. Observed facts never carry an owner.
  A process per user would need a facade at every call site and a
  back-channel for cross-user reads, would buy isolation the trust model
  does not ask for, and would rule out writes that several users make
  together.
- **Projects are private.** `projects.owner` names the one user who may
  change a project or start workspaces in it. Two users adding the same
  GitHub URL get two unrelated projects, each with its own clone, git
  credential and image chain. Everything inside a project (workspaces,
  queued workspaces, drafts, groups, agent sessions, env vars and secrets,
  its config) belongs to the project's owner and carries no owner of its
  own.
- **User-scoped rows** carry an `owner`: `preferences` (git identity, time
  zone), `shortcut_overrides`, `git_credentials` (names unique per owner)
  and `tool_credentials`. Their stores take the owner's id as an argument
  and do no authorization: routes pass the caller's id, and code acting for
  a project passes `projects.owner`.

## Authorization

The sealed `#domain/access` folder owns the check. A verb's caller is an
`Actor`: a request's `Principal`; `systemPrincipal`, for a gated verb the
server calls with no request behind it (a queued workspace's launch, whose
queuer was authorized when queuing); or a workspace's `yaac-mama` call,
which `workspacePrincipal` resolves to the calling workspace's project
owner. A spawned workspace therefore belongs to its caller's owner and
uses that owner's credentials; the cap on spawns in flight stays per
calling workspace, not per user.

There are two access levels:

- **`reader`**: any user, any resource. Workspace lists and details,
  transcripts, diffs, project pages, build files, and the file explorer's
  reads of a teammate's working tree (`/files`, `/dir`, `/file`,
  `/file-at`). `/file-at` runs `git cat-file` in the running workspace,
  but only for a full hex object id and a confined path, under the
  owner's own git config, so a reader gains no execution and, under
  `k8s`, nothing secret the workspace's files do not already show.
- **`owner`**: the resource's owner only. Every write, and the reads that
  grant execution or reach: `/pty/attach`, `/acp/attach` (whose frames
  prompt, cancel and answer permission asks) and `/forward/attach` (a
  tunnel into the workspace's listeners, and so into a nested yaac's full
  API). The attaches are classed by what they grant, not by their method.

`authorizeProject(actor, projectId)` is the check verbs make: every
workspace-scoped verb resolves its workspace's project and asks it. A
project that does not exist is `NOT_FOUND`, never open. A refusal is
`FORBIDDEN` (403).

- Domain verbs authorize before their first side effect, and their
  internal sub-steps pass the actor along rather than checking again.
  Create and queue are checked by `claimDraft`, before any provisioning row
  or group exists. A verb that needs a running workspace passes `owner` to
  `resolveWorkspaceContainer`, which checks the workspace's row before
  asking the runtime, so a non-owner gets 403 whether or not it runs.
- Routes that write rows directly through `#db` (titles, groups,
  set-group, death-seen marks) call `authorizeProject` before the write,
  and a provisioning entry is dismissed or stopped only by its project's
  owner.
- A project's build files are read at `reader` and written at `owner`: the
  build-files routes ask `resolveRoot` for the dir at the level each needs.
- An attach is checked against the workspace's row before the upgrade (a
  real 403) and again against the unit it resolves to when the socket
  opens, so an id with no row yet is not let through.
- Routes that act only on the caller's own data need no check, and a
  second user gets their own answer rather than a 403: `/auth/*` and the
  `/agent/auth` socket, `/config/*`, `/shortcuts/*`. A git credential is
  its owner's alone: renaming, replacing or deleting another user's reads
  as missing, and a project is assigned (or cloned with) only its owner's
  credential (`resolveCredentialForRemote`).
- `/project/add` and `/project/register` create a project the caller then
  owns.
- There is no admin role. The only writes open to every user are retrying
  and dismissing builds of the shared images (base, tools, nestable, proxy,
  netd). Install administration (upgrades, restarts, server env) happens
  through host or cluster access, outside the API.

Every route's row in `test/api/route-matrix.ts` states its `access`
(`public`, `reader` or `owner`). The matrix drives every `owner` row that is
not marked `callerScoped` as a second tailnet user against a server holding
the built-in user's project, workspace, queued workspace, draft,
provisioning entry and build, and expects 403 (or the
substrate's 501); every `reader` row must admit that user. The attaches are
registered in `server-run`, outside `buildApp`, so
`test/api/identity-flow.test.ts` drives them as a non-owner.

## Credentials

- **Tool sign-ins** are `tool_credentials` rows, encrypted, one per user
  and tool. `/auth/*` acts on the caller's own: `/auth/list` lists only
  theirs and `/auth/clear` with `service: all` clears only theirs.
- **The auth daemon** (`yaac auth server`) holds one socket per user in
  `authAgentHub`, and a connection replaces only its own user's socket.
  Login and install flows carry their owner and answer 404 to anyone else,
  so no user can receive an OAuth code another user pastes. The daemon
  seeds the connecting user's git identity.
- **Plan usage** is looked up per user: the snapshot's `planUsage` and
  `codexPlanUsage` map a user id to that user's readout (a user with no
  sign-in is absent), and the webapp's badge shows the caller's own entry
  whoever they are viewing.
- **Creates and spawns** resolve their tool from the project owner's
  sign-ins and are refused without one, and refused until the owner has a
  git identity.
- **Git credentials** (docs/git-credentials.md) belong to their owner and
  are assigned only to that owner's projects. Host-side fetches on a
  project's clone use the owner's credential.

### Under `k8s`: the egress proxy

The proxy's credentials Secret is a map from owner key to bundle, and each
workspace's registration names its owner (docs/workspace-egress.md
"Owners"). The server pushes one bundle per user, holding that user's tool
sign-ins and the git credentials and ssh keys of their projects. Sentinel
swaps, the OAuth refresh hold and write-back, the GitHub token pool and the
ssh agent's identities all resolve through the workspace's owner, so a
refresh in one user's workspace updates only that user's bundle; the
server adopts each key's captures into its user's store.

The owner key is opaque to the driver. `credentialOwnerKey` in
`#domain/auth` makes it the user's id, except for the built-in user, whose
key is `install` (docs/legacy-compat-shims.md "The built-in user's
credentials keep the `install` key").

Per-project registries, the build cache and the user-layer repo are keyed
by project, hence by owner. Registry repositories stay one per project and
layer, since builder-pod write grants are scoped per repository
(docs/trust-split-builds.md "The write gate").

### Under `containerless`

`#domain/auth`'s credential sync seeds each project's tool home from its
owner's store and harvests refreshes back into it. Every workspace can
still read every other tool home on the host.

## Image builds

`Dockerfile.user` and its build files are per user, in
`server-local/users/<user id>/build/` (`userBuildDir`);
`/config/user-dockerfile` and `/config/user-build-files/*` act on the
caller's own. A project's `yaac-user-<projectId>` layer is built from its
owner's file. The driver is handed the owner rather than looking it up:
`prepareImage` takes it from the create, and the prewarm sweep, registry GC
and build retry read it through `projectOwner` (`ProjectReaders`). The
prewarm pool is per project, hence per owner.

Build rows for a project's chain are visible to everyone and retried or
dismissed only by its owner; shared-image builds are open to every user.

## Snapshot and webapp

The snapshot is not filtered by audience: it carries every user's rows.
`ProjectSummary.owner` is its only owner field, since every other row
belongs to its project's owner. The webapp
(`packages/frontend/src/lib/viewer.ts`) cuts it to one user at a time with
`ownedBy(snapshot, userId)`;
install-wide fields (image builds, plan usage, driver) pass through.

- **The user switcher** (sidebar, `tailnet` installs) picks the viewed
  user, which is client state (`viewedUserId`, null for the caller), not a
  URL parameter. A project or workspace link owned by someone else switches
  the view to its owner.
- **A teammate's view is read-only.** Controls that write are hidden or
  disabled, and nothing attaches: a teammate's workspace, running or
  stopped, opens in the transcript view, refetched every 5 seconds. Views
  that write as a side effect (marking a death seen, remembering create
  choices) skip the write. The server refuses all of these anyway.
- **Settings.** A teammate's project pages show read-only, env var names
  with secret values masked. Personal settings (credentials, git identity,
  shortcuts, `Dockerfile.user`) always show the caller's own.
- The waiting chime counts only the caller's workspaces.

## Not covered

- Tagged tailnet devices as callers (resolving them with `whois`).
- Live read-only views of a teammate's chat or terminal (issue #326),
  presence, handoff and comments.
- Team projects, with an owner naming a team and roles within it.
