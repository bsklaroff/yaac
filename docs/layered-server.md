# The layered server

`packages/server` is one process organized in layers. Imports only point
down. Per-layer eslint zones in `eslint.config.js` enforce this (they match
by glob, so a new file gets its layer's rules automatically), together with
the sealed-folder barrels. `pnpm modularity --runtime-only` checks that the
runtime import graph has no cycles (docs/modularity-metrics.md).

```
main       composition root: startup, shutdown, the reconcile loop engine
api        routes/, http/, events.ts (the /events snapshot hub)
  ↓
domain     reads rows, owns what a project and a workspace keep on disk,
           and drives the runtime
 ↓             ↓
db           runtime       db: rows; owns the database outright
               ↓           runtime: driver-neutral machinery for running,
             drivers                observing and attaching to agents
                           drivers: contract.ts + driver.ts, and one
                                    sealed folder per substrate
```

`lib/` sits below everything: helpers every layer may import and that
import no layer back. Its eslint zone allows node builtins and
`@yaac/shared` only, no npm packages: a single third-party import in `lib`
would pull that package (for instance `@kubernetes/client-node`) into every
layer's module graph.

Two package-root modules are exempt from the layering: `#log`, and
`#notify`, a dependency-free "something changed" channel. Anything may emit
on `#notify`; only the api layer's snapshot hub listens.

Below domain there are two independent things, and neither reads the
other: rows (`db`), and the runtime behind its contract (`runtime` and
`drivers`).

## Runtime and drivers

`runtime/` holds what is the same on every substrate: tui/acp agent
conduction, the status watchers and liveness policy, the PTY bridge, report
assembly, and port-forward restore and tunnels. `drivers/` holds what
differs:

- `contract.ts`: the `WorkspaceDriver` interface and its vocabulary;
- `driver.ts`: the registered instance (`setWorkspaceDriver` /
  `workspaceDriver`);
- `k8s/`: one single-pod Job per workspace;
- `containerless/`: one tmux server per workspace on the host
  (docs/containerless-driver.md);
- `shared/`: code both drivers need.

Drivers cannot import each other, so code both need (such as the review
diff's script and parser) goes in `drivers/shared`. The alternative would
be duplicating it, or pushing substrate code up into `#lib` where every
layer would inherit it. `shared/` may not import a driver, and nothing
above the drivers may import `shared/`. Code belongs there only if both
drivers call it and nothing else does.

The composition root picks the driver once at startup, before anything
can ask for one. The choice is the server's placement
(`#main/driver-choice`): a server running as a cluster pod uses `k8s`, a
host process uses `containerless`. Code above the drivers may branch on `workspaceDriver().kind` only to
decide *whether* a feature applies, never *how* it is done. Most callers
need no branch, because the contract specifies per verb what a runtime
without a feature returns (empty, `null`, or a no-op).

Every tmux command, `git -C` call and prompt script that upper layers build
uses `WorkspacePaths`, the driver's answer to where a workspace's files and
sockets are. The k8s driver answers with fixed container paths, because
each pod has its own filesystem. The containerless driver answers per
workspace, because its workspaces share one host filesystem, and a shared
tmux socket would mean a shared tmux server.

`runtime/` and every driver import `contract.ts`; only `main` imports a
driver. At call time a mediator asks the machinery, which asks the driver
through the instance registered in `driver.ts`. So nothing that runs on top
of a driver can name it.

### A driver's public entry point

Each driver is imported through one module: `#drivers/k8s` or
`#drivers/containerless`, its assembly. Everything behind it is internal:
the k8s driver's nine sealed folders and the containerless driver's flat
modules. `#drivers/<kind>/*` may be imported only from inside `drivers/`,
and `main` imports only the assemblies. The CLI is the exception: it
imports substrate administration through the package's `exports` map
(`drivers/k8s/install`, which backs `yaac cluster …`, and
`drivers/containerless/check`, which backs `yaac host check`).

The api layer reaches the runtime the same way domain and runtime do:
through `#drivers/driver` and `#drivers/contract`, never a concrete driver.

### What goes in domain

Code that resolves a workspace, decides something from what it finds, and
then acts belongs in `#domain`. For example, `dismissWorkspacePort` refuses
a port the runtime is not offering, and `getWorkspaceChanges` picks the
fork branch as the diff's default base. A display value the runtime
already has, fetched and rendered as-is, does not need a domain wrapper:
the image-build list and log routes call the contract directly. A wrapper
whose whole body is `return workspaceDriver().x(...)` only hides the call.
Lint cannot tell these cases apart, so this is a convention.

`retryImageBuild` in `#domain/projects` is in domain because it is more
than a wrapper: a retry must hand the runtime a project-config reader, and
the runtime may not read config itself.

### Drivers are handed what they need

A driver never looks up config or credentials itself:

- A launch intent carries the resolved config and the secrets to deliver.
- A reconcile pass hands down the project list and each project's config
  through lazy `PassContext` accessors.
- Credentials are pushed to the driver whole on every change
  (`syncCredentials`), rather than read on the driver's own schedule.
- A step that runs outside a pass (the boot-time forwarder restore, a
  build retry) takes the reader as a plain parameter.

So a driver's own disk reads are limited to its datapath and the images it
builds.

`db` imports nothing sideways either. A column that names a disk location
stores a portable form (a transcript path is project-relative, so it stays
valid if the data dir moves). Resolving it takes layout knowledge, so that
happens a layer up, in `recordedTranscript`.

## What lives where

- **`main/`**: `server-run` (lock, DB open through `openDb`, bind, and the
  one place the driver is registered), `driver-choice` (which driver this
  placement runs), `convergence` (wires what the driver observes into the
  machinery: the per-workspace status watchers, which need a row lookup,
  and two trigger sources no substrate watch can see, a conversation
  appearing and a driver connection dropping), `reconciler` (the pass
  engine; its step list comes from domain), `server`, `lifecycle`.
- **`api/`**: `routes/` (translation only; policy lives below), `http/`
  (auth middleware, the token store, the error envelope, static SPA
  serving), `events.ts` (the snapshot hub).
- **`domain/`**: `workspaces/` (the lifecycle verbs: create, restart,
  stop, cleanup, list, detail, resolve; plus the prewarm pool, spawn
  policy, discovery sweeps, prompt capture, the provisioning registry, the
  stale reaper, and checkout seeding), `projects/` (which projects exist
  and what each keeps on disk: the clone's branches, the two config
  layers, git credentials, Dockerfiles and build files), `git/` (domain's
  one process boundary onto git; docs/server-git.md), `agent-history/`
  (each workspace's conversations on disk), `titles/`, `auth/`, `skills/`,
  `access/` (who may act on what: the verbs that make a user-caused write
  take the caller and `authorize` it), and `reconcile.ts` (the ordered
  step list of one pass).

  Config and credentials live in domain because writing them is policy: a
  saved allowed host or port forward applies to every future workspace of
  the project, and the verb that saves one then asks the runtime to apply
  it live.
- **`db/`**: the workspace, agent-session and project stores, preferences,
  token persistence, `desired-workspaces` (what the reaper compares
  against), `openDb`/`closeDb`, and the event handling below. `client.ts`
  (the PGlite handle) and `schema.ts` (the drizzle tables) are internal,
  off the barrel, so no other layer can name a table or build a query. The
  database driver packages are eslint-banned everywhere else.
- **`runtime/`**: four sealed folders.
  - `agents/`: the tui/acp drivers, acpd's JSON-RPC client, per-tool
    launch commands, and per-tool transcript readers.
  - `status/`: the tmux control-mode watchers feeding the status store,
    liveness probes, workspace classification, and `observeWorkspaces`,
    which joins the driver's raw facts with what the watchers saw.
  - `terminals/`: the PTY bridge, and listing, creating and killing a
    workspace's tmux windows.
  - `ports/`: the forwarder restore after a server restart, and the port
    tunnel (docs/port-forward-tunnel.md).

  All of it runs on whichever driver is registered, so the containerless
  driver gets conduction, observation, attach, report assembly and restore
  without reimplementing them. tmux is the process supervisor on both
  (docs/agent-modes.md).
- **`drivers/`**: `contract.ts` (`WorkspaceDriver` and its vocabulary:
  `RuntimeHandle`, `AgentLiveness`, `RuntimeSnapshot`, the stream types
  `StreamChild` and `StreamPty`, `WorkspaceExecError`, the launch types
  `WorkspaceSpec`, `WorkspaceMount`, `SubstrateIntent` and the opaque
  `WorkspaceSubstrate` receipt, and the pass scheduling types),
  `driver.ts`, `shared/`, `containerless/`, and `k8s/`.

  `k8s/`'s barrel is its assembly (`createK8sDriver`) over eight sealed
  folders: `cluster`, `egress`, `forwarders`, `images`, `image-engine`,
  `workspaces` (launch, locate, claim, teardown, the pod-side changes diff,
  image salvage, and the mapping from a pod to a `RuntimeHandle`),
  `substrate` (client, informers, exec, pod specs, the per-pass
  `TickSnapshot`, the datapath's names and ports) and `container` (podman,
  the local registry client, the streaming child-process runner). Beside
  them are only `lifecycle.ts` (attach and detach) and `steps.ts` (the
  driver's reconcile steps). The assembly can be the barrel because the
  contract sits below the folders: assembly → folders → contract.

  A ninth folder, `install`, is outside that graph. It is what `yaac
  cluster install|check|delete` run: creating the cluster and its CNI,
  re-applying node state a restart drops, building every image yaac ships,
  and deploying the in-cluster pieces, all from the CLI's machine before
  any server exists. An eslint zone bans `#drivers/k8s/install` everywhere
  in the server, which keeps a container engine off every server code path
  (docs/trust-split-builds.md). It imports `cluster` to read each shipped
  image's identity, the name the server later looks it up by.

  `contract.ts` and `driver.ts` import nothing but shared types, enforced
  by an eslint zone on those two files. So code reaching the runtime
  through them pulls no cluster client into its module graph, and the
  contract cannot grow a dependency on the substrate it hides.

### Driver lifecycle

`start(sinks)` attaches and begins watching. `stop()` takes down
everything push-fed before the reconcile loop drains. `release()` drops what
a draining pass still needed (the forward declarations, the proxy client's
state) after the drain. `start` resolving does not mean attached, since a driver may defer
that until first use. `sinks.attached` signals it, and the reconcile loop
starts then. `sinks.recover` fires earlier, once the substrate is usable
but before anything watches it; the forwarder restore runs there.

Two verbs worth knowing:

- **Launch.** `prepareSubstrate` runs once per create and sets up what
  belongs to the workspace (its egress registration, the project
  registry), returning an opaque receipt. `launch` only applies a unit (a
  pod, or a tmux server). A failed create leaves only a unit, which
  `destroy` with `unitOnly` removes when the workspace's row survives (a
  resume or a spare), keeping what its next launch reuses.
- **`list`.** `preferCache` asks for the driver's watch-fed view. The
  snapshot path uses it every time instead of making the apiserver list
  what a watch already streams. A caller that needs the substrate's own
  answer leaves it off.

## Observed facts enter the database through one function

Code that watches the substrate or reads a workspace's disk reports what it
saw as a `WorkspaceEvent`, a discrete past-tense fact.
`applyWorkspaceEvent` in `#db` alone decides which rows it changes. The
per-event row functions are internal to db, so a caller cannot record an
observation any other way. Intent (a title, a sidebar group, a preference)
is written through ordinary db functions, and any layer from domain up may
read rows.

Re-reporting must be safe, which the event types (`db/events.ts`) ensure:

- **Whole sets, never deltas.** `sessions-discovered` carries a
  workspace's full known history. `sessions-active` carries the complete
  live set, and a missing event does not mean an empty set: a watcher that
  cannot see says nothing.
- **Fill-only capture.** An opening message is only ever added, so
  re-reading a compacted transcript cannot rewrite it, and a restart's
  re-report changes nothing.
- **Rollback.** A failed create deletes a fresh workspace but restores a
  resumed one exactly as the restart found it, including its death cause
  and dismissal. The `workspace-created` handler reads and clears the
  prior stop together.

## Pushing changes to clients

Every store that `buildSnapshot` reads calls `#notify` where it changes,
and the api layer's hub is the only listener. The hub coalesces a burst of
notifications, rebuilds the snapshot, diffs it against what it last sent,
and broadcasts only a change. Nothing else publishes: routes return
responses, and the reconciler knows nothing about snapshots.

The rule for new code: **if you change something `buildSnapshot` reads,
notify there.** `applyWorkspaceEvent` covers every observed fact; intent
writers (a title, a group) notify individually.

As a result an idle server rebuilds nothing. The only timer on this path
is the plan-usage refresh, because the upstream usage endpoints cannot
push, and it only runs while a client is connected.

## The reconcile pass

`main/reconciler.ts` runs one serialized, debounced pass at a time, fed by
two lanes: change events and a 60s resync. Each step's errors are
isolated. There is no polling: every source has an event, and the resync
means a missed event costs latency, not correctness, the same bet an
informer's relist makes. Besides the watch-cache events, the triggers are
`live-agents` and `status-streams` (in-workspace facts from the driver
connections) and `proxy-refreshed` (a change to the object the proxy saves
OAuth rotations into).

`domain/reconcile.ts` lists the steps in order: the stale reaper first (so
the prewarm pool counts just-reaped workspaces), the queued-workspace
backstop (a launch interrupted by a restart; `stopWorkspace` launches
queued workspaces directly, so this only rides the resync), the prewarm
pool (k8s only), the conversation sweep, orphan-module
GC, credential adoption (k8s) or sync (containerless), origin refresh, and
title generation last so a just-captured opening message is eligible in the
same pass.

The driver contributes its own steps (its GCs and datapath repairs) in two
groups: `prePool`, before the spare pool sizes itself, and `maintenance`,
after the sweeps that read rows. Those are the only orderings domain cares
about. What the driver's steps do and how they order among themselves is
not named in `domain/reconcile.ts`.

Steps share one `RuntimeSnapshot`, created on first use in the pass, so
every step sees the same instant. Its `workspaces()` and `strayUnits()`
come from one cached substrate view, so "a unit with no workspace" is never
a comparison across two moments, which is what makes the reaper's deletes
safe. The project list and each project's config come from lazy per-pass
accessors (`PassContext`), so a driver step never reads a row or config
file itself. Domain steps read their own (the prewarm pool resolves what to
warm each spare as when it spawns it).

The reaper reads `desiredWorkspaces()` at the start of its own step, so it
only judges absence against a set from the same pass. A failed read skips
every sweep, since reaping on a guess destroys uncommitted work. In-flight
creates are exempt via the provisioning registry, which is filled
synchronously before a create stages anything.

## Naming

Per docs/naming.md, a **workspace** is the sandbox unit and a **session**
is one agent conversation. The event union and its handler say
"workspace" (`WorkspaceEvent`, `applyWorkspaceEvent`).

The **driver** is what a substrate implements (`WorkspaceDriver`,
`drivers/k8s`, `workspaceDriver()`). The observation types say "runtime"
(`RuntimeHandle`, `RuntimeReport`, `RuntimeSnapshot`) on purpose: there
"runtime" means observed right now, as opposed to the durable facts `db`
keeps. `DriverReport` would read as a report about the driver.
