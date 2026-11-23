# Delegated actors

A workspace's `yaac-mama` call acts as its project's owner, but only within
limits: a subset of verbs, its own project, a permission-mode ceiling, a cap
on launches in flight, and never as a person or an admin. A bearer-token
caller (docs/plans/token-endpoint.md) is to be held to the same limits.

This plan makes those limits one permission, **delegate**, checked by the
access layer and the verbs it guards, and then puts every delegate on the
API's own routes:

1. The limits move out of `mama.ts` and into the verbs.
2. The API learns to answer a delegate.
3. The `yaac-mama` endpoint stops calling the domain and becomes a
   translator onto those routes, so a capability has one implementation.

The token plan is then left with what is its own: token bindings in the
database, and a listener on an address and port.

## Today

`Actor` in `#domain/access` is a request's `Principal` (`local` or
`tailnet`), `{ kind: 'system' }`, or `{ kind: 'workspace', workspaceId,
userId }`, which `workspacePrincipal` builds for `mamaCaller`. A workspace
actor passes `authorizeProject` for any project of its owner, at any verb.
What holds it back is elsewhere:

| Limit | Where it is enforced |
|---|---|
| Which verbs | `MAMA_COMMANDS`: there is no command for the rest, and under k8s a pod reaches the server nowhere else |
| Its own project, reads included | Each handler in `mama.ts` passes `caller.projectId`, or resolves a workspace with `resolveProjectWorkspace` |
| Permission ceiling | `caller.permissionMode`, threaded five ways: `QueueSource`'s `ceiling`, `SpawnRequest.callerPermissionMode`, `RestartRequest.callerPermissionMode`, `aboveCaller`, and a loop in `runSend` |
| Commands only at `bypass` | `refuseCommands` in `mama.ts` (`--steps`, `--run`) |
| Launches in flight | `inFlightByCaller` in `spawn-policy.ts`, keyed by the calling workspace |
| Not a person | `requirePerson`, and `isPerson` wherever provenance is decided (`personWritten`, `personSaved`, `approveStart`, `admitLaunch`) |
| Not an admin | `requireAdmin` names the one kind it knows, `actor.kind !== 'workspace'`, so a new kind would pass by default |
| A published site's volume | `volumeForLaunch` tests `actor.kind === 'workspace'` |

The first five are conventions of one caller, kept by a surface built
beside the API: `workspace-bin/yaac-mama`, a shell script of about 1,500
lines, posts `{ command, args, body, session }` to `POST
/api/workspace/mama`, and `mama.ts` and `sites/mama.ts`, about 2,400 lines,
check the arguments, call the verbs and render the text. Nearly every
command repeats one the `yaac` CLI has over a route.

Three smaller things are off the access layer too. The owner comparison is
written three times (`authorizeProject`, `ownRepo`, `dismissProjectAdd`).
`GET /repo/:repoId/branches` passes `systemPrincipal` from a request to
skip an owner check. And the request log names no caller for a `yaac-mama`
call.

## The abstraction

### Types

```ts
// @yaac/shared/types
export type Principal =
  | { kind: 'local'; userId: string }
  | { kind: 'tailnet'; userId: string; login: string; name: string }
  | Delegate

/** Something acting for a user, within limits, that is not that person. */
export interface Delegate {
  kind: 'delegate'
  /** The user it acts for. */
  userId: string
  /** That user's login, for logs; null for a local install's one user. */
  login: string | null
  /** What is acting: a stable id, a few words for logs and refusals, and
   *  for a workspace the session that says it is asking. */
  via: { kind: 'workspace'; id: string; label: string; sessionId?: string }
  /** The one project it may read or act in; absent, any its user may. */
  projectId?: string
  /** The most permissive mode anything it starts or messages may run in. */
  ceiling: PermissionMode
}

// #domain/access
export type Actor = Principal | { kind: 'system' }
```

The delegate joins the shared `Principal` because it is one more answer to
"who sent this request", which `GET /whoami` gives. It is a kind of its
own rather than a flag on a person, so code that forgets to ask treats it
as not a person. The context variable stays `principal: Principal`.

`mamaCaller` becomes `callingWorkspace(workspace, sessionId)` in
`#domain/workspaces`, which answers a `Delegate`: `userId` and `login` its
project owner's, `projectId` its project, `ceiling` the posture it
resolves today as `permissionMode`, `via.label` as `workspace 1a2b3c4d`.
Whoever builds a delegate has its user's row in hand, which is why the
login rides along rather than being looked up later. A site's release is refused there, as `mamaRoute`
refuses it now. No permission check reads `via`; only rules about the
caller itself do (it may not message its own session, and it is handed
only its own repos' tokens).

### The delegate level

A verb states who may call it, as the route matrix's `access` already
does. One level is added, between `reader` and `owner`:

- **`delegate`**: the project's owner, or a delegate of theirs.
- **`owner`** now means the owner in person, and `admin` an admin in
  person.

`authorizeProject(actor, projectId, level = 'owner')` is where it is
decided. At `owner` it refuses every delegate. At `delegate` it admits one
whose user owns the project and whose `projectId`, if it has one, is that
project. The verbs `yaac-mama` reaches today pass `'delegate'`; every
other verb, and every verb written later, refuses delegates without saying
anything.

`isPerson` stays the one place that knows which kinds are people.
`requireAdmin` asks it instead of naming a kind. `requirePerson` stays for
the verbs whose answer depends on state: a `delegate` verb that a
published site turns into a person's (`stopSite`, `deleteSite`, cancelling
a deploy, `approveContent`). Where it only repeats an `owner` check
(`publishSite`, `unpublishSite`) it is deleted.

### The ceiling and the launch cap

Both move into the verbs that launch or message an agent, which read them
from the actor:

- `requireWithinCeiling(actor, mode, what)` in `#domain/access` refuses a
  delegate asking for more than its ceiling, and passes a person and the
  server. It replaces `aboveCaller`, the loops in `decideRestart` and
  `runSend`, and `refuseCommands` (commands need a ceiling of `bypass`).
- `prepareStart`, `openSession` and the queue's `resolveSettings` settle a
  delegate's permission mode with `agentPermissionMode` against
  `actor.ceiling`. A mode it does not name is its ceiling, never the
  project's remembered one, which could leave an agent at a prompt nobody
  answers. `QueueSource` and the `source` parameter of `queueWorkspace`,
  `updateQueuedWorkspace`, `createRoutine` and `updateRoutine` are deleted.
- A delegate restarts only a stopped workspace, as `decideRestart` holds
  it to now; `prepareRestart` applies that from the actor.
- The in-flight cap is taken in `prepareStart` and `prepareRestart` for a
  delegate, keyed by `via.kind` and `via.id`.

`spawn-policy.ts` is deleted. The one thing in it that is a default rather
than a limit moves to `resolveCreate`: a start by a workspace's delegate
that names no tool, model or agent mode takes its calling session's, ahead
of the project's remembered ones.

### Attribution

- A refusal names the delegate by `via.label`, in place of "in the webapp
  or with `yaac`".
- `actorLabel(actor)` on the barrel is the audit name: `server`, a
  person's login, or `<login> via <label>`, read from the actor's own
  `login` and `via.label` and never its `userId`. `requestLogger` prints it
  for a tailnet or delegated caller.
- A site's requested deploy keeps storing the workspace id (`via.id`) for
  a workspace delegate, so stored rows read as before.

## Delegates on the API

### The gate

`delegateApp(resolve)` in `#api` is the API's HTTP routes behind a gate
that admits only a delegate: `resolve` turns a request into a `Delegate`
or nothing, and nothing is the gate's 401 `UNAUTHENTICATED`, with
`WWW-Authenticate: Bearer`; a resolver that can say more (an expired
token) throws that refusal. No route behind it is public, `/api/health`
included. It serves no WebSocket route and no SPA, runs none of the
browser guards and never answers `local`. Two callers use it:

| Way in | Who it resolves | Owned by |
|---|---|---|
| The `yaac-mama` endpoint, dispatching in the server process | the calling workspace, which the endpoint has already identified | this plan |
| The token listener | the user a binding names | the token plan |

### Reads

A delegate with no `projectId` reads what any user reads. A scoped one
reads only its project, which `mama.ts` holds it to now by passing its
project to every call, and reads carry no check today. So the gate checks
them: for a scoped delegate, a `reader` route is admitted only when the
project it names is the delegate's. The project is the route's
`:projectId`, the project of the workspace its `:id` names, or its
`project` query. A read that names none (`/project/list`, `/repo/list`,
`/image/builds`, the snapshot) is refused, except `GET /whoami`. One
function decides, and it fails closed.

### The caller's own data

Some routes act on the caller's own data and name no project, so no
level guards them: `/auth/*`, `/config/*`, `/shortcuts/*`,
`/project/add|register|create|order`, the seen marks, `/feedback`, a push
to a hosted remote and the sign-in socket. They read the caller's user id
and hand it to a store that authorizes nothing. A delegate's `userId` is
its user's, so it would pass.

`personId(principal)` in `#domain/access` answers that id for a person and
refuses a delegate, and is the only way code outside the access folder
gets it. A delegate therefore has no account of its own: it neither
changes nor reads its user's sign-ins, credentials, settings or shortcuts.
What an agent needs of them is asked about a project instead (its owner's
models, its owner's time zone), which the server resolves.

An eslint rule on `packages/server/src/**` bans reading `userId` off a
principal or an actor (`principal.userId`, `actor.userId`,
`c.get('principal').userId`, and destructuring it from either), as
`no-process-env` bans `process.env`. Two reads carry an inline disable,
both in `access/authorize.ts`, and neither can hand a delegate's user to
its caller:

- `personId`, which answers the id only for a person.
- `authorizeProject`, which compares it with the owner of a project it
  looks up itself, and answers nothing.

No helper returns the id and none compares it with a user the caller
supplies, so there is nothing to borrow: `ownRepo`, `dismissProjectAdd`
and `requireAdmin` use `personId`, since a repo, a failed add and a role
are a person's. A third read would need a third disable, which is what a
reviewer looks for. The rule matches by name, so the route matrix stays
the check that no route slipped past it.

### What a delegate reaches

Every read but those of the caller's own data (a scoped delegate, in its
project), and the writes at `delegate`:
workspace create, stop, restart and rerun; opening and closing sessions;
adding steps; title and base branch; the queue, routines, groups (create,
move, set-limit) and workflows; the project icon; and an unpublished
site's create, edit, deploy, start, stop and delete. Step logs
(`/workspace/:id/logs`) drop from `owner` to `delegate`, since agents read
them already.

Everything else is a person's: deletes of workspaces, projects, repos and
volumes; project config; repos and pushes over the API origin; the
caller's own account; the attaches, terminals, file writes and forwards;
publishing and anything on a published site; approvals; roles. The routes
that sit beside a mama command without being one stay `owner` too:
cancelling or rerunning a step, resuming a session or changing its title
or agent options, a workspace's timeout, renaming, deleting or pinning a
group, drafts, and dismissing a failed provision.

## yaac-mama on the API's routes

The script, its endpoint and what a pod can reach do not change:
`workspace-bin/yaac-mama` still posts a command to `POST
/api/workspace/mama`, under k8s through the proxy's relay. What changes is
what the endpoint does with it. It stops calling domain verbs and becomes a
translator onto the routes, the shape usually called a backend for
frontend: one client's own interface, kept beside the general API and
built on it.

- **Each command is one or more requests to the API's routes**, made in
  the server process as the caller's delegate, and its answer is rendered
  from theirs. The translator holds the same typed client the CLI uses
  (`createApiClient`), given a `fetch` that calls `delegateApp` in memory
  with the delegate `callingWorkspace` answered. It acts with the caller's
  authority and has none of its own, so a route refuses through it exactly
  what it refuses a token caller.
- **It moves to `src/api`**, as `api/mama/`, since a layer that reads
  routes and renders text is presentation. `workspaces/mama.ts` and
  `sites/mama.ts` go, with `answerSiteCommands`, which existed because
  workspaces could not import sites. What is left in the domain is
  `callingWorkspace` and `sendMessage` (today's `runSend`).
- **It keeps** `MAMA_COMMANDS`, each command's accepted options, the
  mapping of options onto a route's input, and every line it prints. Its
  output does not change, except that a refusal a route makes names the
  delegate ("Attribution").
- **It loses** every domain call, every scoping of a call to the caller's
  project, and every limit, which the routes and the gate now hold.
- **Commands with no route get one.** `yaac` gains `workspace send`, which
  a token caller's script wants; the others are about a checkout the caller
  sits in, and stay `yaac-mama`'s alone:

  | Command | Route | Level |
  |---|---|---|
  | `send` | `POST /workspace/:id/send` | `delegate` |
  | `fetch` | `GET /workspace/:id/bundle` | `reader` |
  | `history` | `GET /workspace/:id/history`, and one file of it | `reader` |
  | `models` | `GET /project/:projectId/models` | `reader` |
  | `as-repo` | `GET /workspace/:id/repo/:repo/gh-token` | `delegate`, and only the workspace itself |

A capability an agent should have is then a route at `delegate` plus a
line of translation, and one the translator asks for that the route does
not allow is refused by the route.

The translator stays on the server rather than in the pod on purpose. A
client that rendered there would be a Node program of about 130 MB per
call, or a second language with its own copy of the wire types. On the
server the pod keeps a script of a few megabytes, the pod still reaches
one endpoint, and a workspace started before an upgrade keeps working,
since the server it calls renders for it.

## What the token plan owns

- The `token_bindings` table and its store.
- Creating, listing and deleting a binding. Create and delete are `owner`:
  a person's, which no delegate passes.
- `resolveBearer`, which answers the `Delegate` for a token: a `via.kind`
  of `token`, its owner's `userId` and `login`, no `projectId`, and the
  binding's `ceiling`. The person
  creating the binding chooses the ceiling, and it defaults to the
  driver's default mode, `bypass` under k8s and `accept-edits` under
  containerless (`defaultPermissionMode`, without its per-tool exception,
  since a binding is tied to no tool). A containerless token left at the
  default can therefore start no pi agent and hand a workspace no commands.
- The listener: its address, port and TLS, how each substrate exposes it,
  and the client's `--token-command`. It mounts `delegateApp(resolveBearer)`.

Per-project tokens are not planned, but would be a binding that sets
`projectId`.

## Call sites

| Module | Change |
|---|---|
| `@yaac/shared/types` | `Delegate`; `Principal` gains it |
| `access/authorize.ts` | `Actor` loses `workspace`; the level on `authorizeProject`; `requireWithinCeiling`; `personId`; `actorLabel` |
| `access/roles.ts` | `requireAdmin` asks `isPerson`, and reads the role of `personId(actor)` |
| Verbs behind the routes listed under "What a delegate reaches" | pass `'delegate'` |
| `workspaces/queued-workspaces.ts`, `routines.ts`, `start.ts`, `restart.ts`, `sessions.ts`, `steps.ts`, `create.ts` | the ceiling, the cap and the calling session's defaults |
| `workspaces/volumes.ts` | the published-volume guard tests `actor.kind === 'delegate'` |
| `sites/sites.ts`, `sites/deploys.ts`, `workspaces/stop.ts` | levels; `requestDeploy` reads `via` for who asked |
| `repos/access.ts`, `projects/adding.ts` | the owner comparison reads `personId` |
| `projects/workflows.ts` | delete `savedByPerson`; its one caller asks `isPerson` |
| `workspaces/mama.ts`, `sites/mama.ts`, `workspaces/spawn-policy.ts` | deleted; `callingWorkspace` and `sendMessage` are what remain in the domain |
| `api/mama/` | the translator |
| `api/http/web-auth.ts`, `main/server.ts` | `delegateApp` and the scoped-read check |
| `api/routes/*`, `api/ws-routes.ts`, `repos/hosted.ts`, `feedback/submit.ts`, `workspaces/waiting-seen.ts` | `personId` wherever a principal's `userId` is read |
| `eslint.config.js` | the ban on reading `userId` off a principal or actor |
| `api/routes/*` | the five routes; a route that authorizes before a direct `#db` write (titles, groups) passes `'delegate'`; the branches read stops passing `systemPrincipal`; `mamaRoute` hands its command to the translator and sets `principal` for the log |
| `packages/cli` | `yaac workspace send` |

The script, the proxy's relay and the relay listener are untouched.

## Order of work

One piece, landed in steps that each leave `yaac-mama` working:

1. Types, levels and attribution. The mama endpoint answers as before, and
   its tests show every verb it reaches is marked.
2. The ceiling and the cap move into the verbs.
3. `delegateApp`, the scoped-read check, `personId` with its lint rule,
   and the matrix's delegated callers. The token plan can land on this.
4. The five routes, then the translator, a command at a time: each moves
   from a domain call to a request, and the rest keep working beside it.

## Tests

`packages/server/test/domain/access/` keeps one `describe` per barrel
function, in the file of the module that defines it:

- `authorize.test.ts`: `authorizeProject` over each level and a person, a
  delegate, a delegate scoped to another project and the server;
  `requireWithinCeiling`; `personId`; `actorLabel`; `isPerson`;
  `requirePerson`.
- `roles.test.ts`: `requireAdmin` refuses an admin's delegate.

The limits are tested where they live, through the verbs with a delegate
as the actor: a start, session, queue entry, routine, restart and step
above the ceiling are refused in the tests of `prepareStart`,
`openSession`, `queueWorkspace`, `createRoutine`, `prepareRestart` and
`addSteps`, and the cap in `prepareStart`'s. `callingWorkspace` and
`sendMessage` take over the cases of `mamaCaller` and `runSend`.
`savedByPerson`'s `describe` goes with the function.

`mama.test.ts` and `sites/mama.test.ts` move to `test/api/mama/` with the
translator and keep their cases: a command in, the text out, against the
real routes and verbs, mocking only what those already mock. One case per
limit shows a route's refusal reaches the caller as text, and one asks for
a workspace of another project by id and is refused by the gate.

The route matrix carries the rule for every route:

- `access` gains `delegate`, and each of the five routes gets a row.
- Every row is driven as a delegate of the project's owner: `owner` and
  `admin` rows, and every row marked `callerScoped`, reads included,
  expect 403; `delegate` rows and the other `reader` rows must admit it.
  The seen marks and `/feedback` become `callerScoped`.
- Every `reader` and `delegate` row is driven as a delegate scoped to
  another project and expects 403, which is what catches a read that names
  its project some way the gate does not see.

Both drive `delegateApp` with a resolver that answers the fixture's
delegate, so they run in each driver's column with no workspace.
`write-routes.test.ts` covers what the five routes do.

`test/e2e-cli`'s `workspace-mama-suite` and `site-suite`, and
`test/e2e-containerless`'s workspace suite, already drive every
`yaac-mama` command and option and assert what each prints, and are the
check that step 4 changed none of it; `yaac workspace send` gets its cases
there too. The k8s suites need a host run before step 4 lands.

## Docs

- docs/multi-user.md "Authorization" and "Roles": the `delegate` level,
  `owner` and `admin` as a person's, and a caller as a person, a delegate
  or the server.
- docs/cli.md: `yaac workspace send`.
- docs/permission-modes.md "A spawned workspace's posture",
  docs/workspace-steps.md "Permissions", docs/queued-workspaces.md and
  docs/routines.md: the ceiling as a delegate's, enforced by the verb.
- docs/public-sites.md "Publishing" and docs/workflows.md "Approvals":
  where they say "agent" for a rule that holds for any delegate, say so.
- docs/layered-server.md: the `access/` entry, and the translator in
  `src/api`.
- The header comments of `access/index.ts` and `test/api/route-matrix.ts`.
- Delete this plan.
