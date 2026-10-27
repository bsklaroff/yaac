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
users. Under `k8s` workspace pods cannot reach the server, and node
addresses reach its API only behind the kind forwarder, so only the
install's own machine can forge those headers (docs/server-in-cluster.md
"The ingress policy is the wall").

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
  own. A hosted project can be shared, which gives another user a project
  of their own on the same repository rather than a second owner
  (docs/hosted-projects.md "Sharing").
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
  transcripts, diffs, project pages, build files, the file explorer's
  reads of a teammate's working tree (`/changes`, `/dir`, `/file`,
  `/file-at`), and `/acp/observe`, which follows a running conversation
  (see "Following a teammate's conversation"); its only answers are reads
  of what the conversation names, a background task's output and a
  subagent's transcript. Marking a waiting workspace or a death read is
  open to readers too, since it records only that the caller saw it (see
  "Snapshot and webapp"). `/file-at` runs `git cat-file` in the running workspace,
  but only for a full hex object id and a confined path, under the
  owner's own git config, so a reader gains no execution and, under
  `k8s`, nothing secret the workspace's files do not already show.
- **`owner`**: the resource's owner only. Every write, and the reads that
  grant execution or reach: `/pty/attach`, `/acp/attach` (whose frames
  prompt, cancel and answer permission asks) and `/forward/attach` (a
  tunnel into the workspace's listeners, and so into a nested yaac's full
  API). The attaches are classed by what they grant, not by their method.
  A push to a project's hosted remote is a write, so it is the owner's; a
  clone or fetch of it is a read (docs/hosted-projects.md).

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
- Routes that write rows directly through `#db` (titles, groups, group
  moves) call `authorizeProject` before the write, and a provisioning
  entry is dismissed or stopped only by its project's owner.
- A project's build files are read at `reader` and written at `owner`: the
  build-files routes ask `resolveRoot` for the dir at the level each needs.
- An `owner` attach is checked against the workspace's row before the
  upgrade (a real 403) and again against the unit it resolves to when the
  socket opens, so an id with no row yet is not let through.
  `/acp/observe` checks only that the workspace exists and runs.
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
- **The desktop app's auth daemon** holds one socket per user in
  `authAgentHub`, and a connection replaces only its own user's socket.
  Login and install flows carry their owner and answer 404 to anyone else,
  so no user can receive an OAuth code another user pastes. The daemon
  seeds the connecting user's git identity.
- **Plan usage** is looked up per user: the snapshot's `planUsage` and
  `codexPlanUsage` map a user id to that user's readout (a user with no
  sign-in is absent), and the webapp's badge shows the caller's own entry,
  hiding while they view a teammate.
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
key is `install`. Running workspaces' registrations name that key, so
changing it would strand them until they are recreated.

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
  URL parameter. Picking a user reopens the project of theirs last open on
  that device (else their first), and each project reopens the workspace
  last open in it. A project or workspace link owned by someone else
  switches the view to its owner. Each user's row shows how many
  workspaces they have live (including ones being created or restarted)
  across all their projects, or `idle`; the count is install-wide, like
  the snapshot it reads.
- **A teammate's view is read-only.** Controls that write are hidden or
  disabled, and nothing that grants control attaches: a teammate's
  workspace, running or stopped, opens in the read-only pane (the same one
  the caller's own stopped workspaces open in), and a running one's
  conversation is followed live over `/acp/observe`. Its markers are the
  sidebar's (`StatusMark`, from the snapshot's per-conversation status),
  and an ask says it waits on the teammate by name. Views that write as a
  side effect (remembering create choices) skip the write. The server
  refuses all of these anyway.
- **Settings.** A teammate's project pages show read-only, env var names
  with secret values masked. Personal settings (credentials, git identity,
  shortcuts, `Dockerfile.user`) always show the caller's own.
- **Unread dots are the viewer's.** A workspace's row lists the users who
  have viewed its current waiting spell (`waitingSeenBy`, emptied when it
  goes back to work) and its death (`deathSeenBy`, emptied when it stops
  again). The snapshot carries those lists, and for a project or group its
  deaths with how many each user has seen (`deaths`, `deathsSeenBy`), so
  the sidebar's dots and the rail's count say whether the caller has seen
  them, on a teammate's workspaces as on their own. Opening one, or "Mark
  all as read", marks it for the caller only.
- The waiting chime counts only the caller's workspaces.
- **The CLI** cuts the same way: project names and the project, workspace
  and group listings mean the caller's own projects, or those of the user
  `--user` names (docs/cli.md "Whose projects").

## Following a teammate's conversation

`/acp/observe?id=&session=` sends a reader the frames a chat pane gets
(`hello` with the last page, then events) for either mode, so the read-only
pane has one code path. It follows only the selected conversation, and shows
the transcript route's last page until the stream's first one arrives.

- **`acp`.** The pane bridge (`attachAcp`) with `control: false`: every
  frame that would act on the conversation (a prompt, cancel, permission
  answer, queue, model, posture, effort or task stop) is dropped, and only
  the two reads are answered.
- **`tui`.** There is no record, only the tool's own history, so one
  `HistoryTail` per conversation (`#domain/workspaces`) follows it for all
  of its readers. It stats the history's files every 250 ms, translates them
  when they change (`followHistory`, which for claude reads only what was
  appended), and sends each reader the events added since; a translation
  that changed what was sent (a `/rewind`) greets them again. A subagent's
  transcript is followed the same way: each reader follows the last one it
  opened, and each one followed is translated once per change and sent to
  all its readers. The next pass waits at least four times as long as the
  last took, so a huge history is followed less often rather than costing
  more of the server. A conversation nobody follows costs nothing, a
  waiting one a few stats a second, and readers past the first only the
  frames sent to them, so readers are not capped. The tail holds what it
  translated only while someone follows. Its `hello` carries `history`:
  the history records no turns, so the pane takes the agent's state from
  the snapshot.
- **What a reader is not sent.** The messages the owner queued for the end
  of a turn, which the owner may still withdraw: a reader's `hello` carries
  none and no `queue` frames follow.

The tools write history a message at a time, so a `tui` conversation's
reader sees each reply, tool call and result once written, not its text
streaming in. opencode under `k8s` is the exception: the server sees it only
through the checkpoint's export, every few minutes (issue #465).

## Not covered

- Tagged tailnet devices as callers (resolving them with `whois`).
- A live read-only view of a teammate's terminal, presence, handoff and
  comments.
- Team projects, with an owner naming a team and roles within it.
