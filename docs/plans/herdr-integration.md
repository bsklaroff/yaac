# yaac × herdr: yaac as a herdr-core machine

herdr 2 comes in two halves, both Apache-2.0 and both released on 2026-10-30:

- **herdr-core** (`hc`, v0.1.14, [herdrdev/herdr-core](https://github.com/herdrdev/herdr-core)).
  This is the runtime. It holds terminals that outlive their viewers, the
  status their programs report, parent/child agent relationships, and remote
  machines. It draws nothing.
- **herdr-app** (v0.1.9, [herdrdev/herdr-app](https://github.com/herdrdev/herdr-app)).
  A native GPUI desktop client of the core. It owns spaces, tabs, splits, an
  agents sidebar, and JavaScript "mods". It keeps its layout in a document
  stored in each machine's core.

The herdr 1 TUI ([herdrdev/herdr](https://github.com/herdrdev/herdr), 0.9.5)
is a separate, monolithic product. This plan does not target it; see
"herdr 1" at the end.

The goal is for yaac on k8s to be the backend and herdr to be the frontend.
herdr-core is built for exactly this split. Its whole client surface is a
small JSON-RPC API that only ever grows (protocol generation 1, an OpenRPC
document, and a release test that fails on any breaking change). A core
reaches other machines through any command that carries stdin and stdout
(`hc machine add --via '<cmd>'`).

So **yaac implements the herdr-core generation-1 protocol** and the user
adds it as a machine:

```sh
hc machine add --name yaac --via 'yaac hc-connect'
```

From then on:

- The desktop app, `hc ls`, `hc attach yaac/t3`, `hc send yaac/t3 "…"` and
  `hc wait yaac/t3` all run against yaac workspaces.
- Nothing in herdr is patched or forked.
- Every `hc` command and every core method has a yaac equivalent: yaac
  answers it, because yaac *is* that machine's core.

## How herdr-core works, in the parts we must reproduce

Read from `schema/README.md` and `crates/herdr-core/src/{api,machines,remote,status}.rs`.

- **The connection.** JSON-RPC 2.0, one message per line. `hello {generation,
  framed}` answers with `{generation: 1, version, core, methods, features:
  [framed, attach, events, status, shell]}`. Framed mode multiplexes
  channels, with each frame laid out as `[channel u32][kind u8][len u32]
  [payload]`. The kinds are DATA, CREDIT, CLOSE, RESIZE, FOCUS and FACTS.
  Channel 0 carries the JSON-RPC.
- **Remote machines.** The local core spawns `<via-cmd> "<shell line that
  execs herdr-core connect>"` and speaks the protocol over the child's stdio.
  It waits up to 20 s for the hello reply and skips any banner lines before
  it. It refuses a peer on a different generation. After that it forwards
  any method called with `on: "yaac"` (`line.call(name, method, params)`),
  merges the peer's events into its own stream as `yaac/tN`, and resyncs on
  reconnect. A `--via` peer is never checked with `uname` or for a binary
  version; only the generation is checked.
- **Terminals** are the only object a core holds. They form a flat list
  (`t1`, `t2`, …). Each record carries `argv`, `cwd`, `labels` (free-form
  `key=value` that the core never interprets), `state`, `status`, `turn`,
  `title`, `cols`/`rows`, `foreground {pid, name, argv, cwd}`, `parent`,
  `keep`, `reason` and `exit_code`. Spaces and tabs are not core concepts.
- **Status** is only what the program reported through OSC 7501, the
  Program Status Protocol. The words are `idle`, `working`, `done`,
  `blocked` and `error`, plus `kind` (permission, question or auth),
  `progress`, `app`, `title` and `msg`. The core never infers status from the
  screen. `turn` increments each time the root record leaves `working`.
- **Attach.** The core sends a first paint: the screen, optional history,
  the latest status as OSC 7501, the title, and `CSI ?9001h/l`. It then
  streams raw output **minus the terminal queries the core already
  answered**. The viewer sends raw key bytes, which the core never
  re-encodes. The last active viewer sets the size. Each stream starts with
  256 KiB of credit, and a viewer more than 4 MiB behind gets a repaint
  instead of the backlog. This is close to yaac's pane mirror
  (docs/terminal-mirror.md) point for point.
- **Events.** `events.subscribe` answers with a snapshot, then sends
  `event {seq, type, terminal, data}` notifications. The types are
  `created`, `lost`, `restarted`, `keep`, `finished`, `removed`, `status`,
  `turn`, `title`, `labels`, `size`, `foreground` and `doc`. A `heartbeat`
  arrives every 15 s, and a subscriber that falls behind gets `missed` with
  a fresh snapshot.
- **Documents.** `doc.get` and `doc.set` store opaque JSON (at most 1 MiB)
  with a compare-and-swap on `version`, and emit a `doc` event on change.
  The app keeps its spaces, tabs and split trees here, in a document named
  `herdr-app` on each machine.
- **What the app needs.** herdr-app checks its *local* core for
  `terminal.run/list/kill/label/attach/keep`, `doc.get/set` and
  `events.subscribe` (`USES` in `src/hc.rs`). It also calls
  `terminal.get/read`, `machine.list` and `server.status`. Everything on
  another machine goes through the local core with `on`. When the app runs
  a terminal it labels it `herdr.space=<space id>` and `herdr.tab=<tab id>`,
  and passes the space's folder as `cwd`.

## Architecture

```
herdr-app ──hc connect──► local hc ──spawn: yaac hc-connect──► yaac server
                           (user's)    (stdio ⇄ WS pipe)        /api/hc  (WS)
                                                                  │
                         hc CLI / agents ─────────────────────────┘ (via local hc, on: yaac)
                                                                  ▼
                                    workspaces · tmux windows · status store · files
```

- **`/api/hc` on the yaac server is a new WebSocket route that speaks hc
  generation 1.** Each WS binary message carries hc bytes unchanged:
  JSON lines before `hello {framed:true}` and frames after it. It lives in
  `src/api/hc/` and reaches domain and the runtime on the same terms as any
  other API module. It holds the state the protocol needs to be stable for
  every connection and every user:
  - terminal addresses, so the same window keeps the same `tN`;
  - the event `seq` counter;
  - labels;
  - documents.
- **`yaac hc-connect`** is a thin CLI command. It ignores the shell line
  that hc appends, resolves the server through `server.json` (or `--server
  <url>`), opens `/api/hc`, and pipes stdio to the socket without changing
  any bytes. It never prompts. When it cannot reach the server it exits
  non-zero with the reason on stderr, which hc shows as `unreachable`. It
  carries the same identity as any CLI request: loopback under `local`, the
  tailnet login under `tailnet` (docs/remote-hosting.md).

The protocol goes on the server, not in the CLI, because addresses,
documents and the event sequence must be shared by every screen. A user
with herdr-app on two machines, or the app plus `hc` in a script, must see
one `yaac/t7`. The server already holds the status store, the tmux control
clients and the snapshot hub, so the adapter is a projection of state that
already exists rather than a second cache of it.

### The model: yaac is one machine, and its terminals are tmux windows

Each window in each workspace the caller can see is one hc terminal:

- The agent window, and each window in `WorkspaceListEntry.terminals`, of a
  **running** workspace is a `live` terminal.
- A **stopped** workspace's agent window is a `finished` terminal, shown
  under `terminal.list {all: true}`. Its `reason` is `server_stop` for a
  user stop, or `killed` for a stale reap, and it can be read through the
  transcript. `terminal.run` with `argv: ["yaac-restart"]` on its folder
  restarts it (see below).
- yaac-owned labels:
  - `yaac.workspace=<id>`
  - `yaac.project=<id>`
  - `yaac.role=agent|terminal`
  - `yaac.tool=<tool>`
  - `yaac.mode=tui|acp`
  - `yaac.group=<group>` when the workspace is in a group

  Labels set by the client (`herdr.space`, `herdr.tab`, anything else) are
  stored beside them. hc never interprets labels, so neither side collides
  with the other.
- `name` is the workspace slug for the agent window (so `hc attach yaac/fix-login`
  works) and the window name for the others.

**Paths are virtual.** Every pod's checkout is `/workspace`, so a path alone
cannot say which workspace it belongs to. The adapter presents
`/yaac/<project>/<workspace>/<path in checkout>` in `cwd` and
`foreground.cwd`, and translates back on every call that takes a path:
`terminal.run`, `file.*`, `machine.exec` and `terminal.put`. Because a new
app tab "starts in the focused terminal's folder", a new tab on a yaac
workspace lands in that same workspace with no app changes.
`/yaac/<project>` (no workspace) means "a new workspace of this project".
`/yaac` lists projects through `file.read` of a directory, if hc's file
methods allow it; otherwise a mod picks the project.

**Status is a projection of yaac's status store.** yaac already knows each
agent's state (docs/agent-modes.md), so the adapter writes it into the
terminal record and emits `status` and `turn` events. Nothing is parsed from
the screen or from OSC 7501.

| yaac (`ListedAgentStatus`) | hc `status.state` | notes |
|---|---|---|
| `running` | `working` | |
| `background` | `working` | `msg` names the background task |
| `waiting` after a turn | `done` | `turn` increments as the turn ends. The app turns `done` into Done or Idle from its own "seen" view, as it does for any agent. |
| `waiting`, never prompted | `idle` | |
| `waiting` + `asking` | `blocked` | `kind: "permission"` (ACP asks carry the tool and title in `msg`) |
| agent process dead (death report) | `error` | `msg` is the death reason |

`app` is the tool name, `title` is the workspace title, `progress` is
omitted, and `status_ms` is `waitingSinceMs` (or the moment of the last
change). Non-agent windows have no status, like any program that does not
speak OSC 7501.

`foreground {pid, name, argv, cwd}` and `title` come from the tmux control
client. Each workspace already has one, so the adapter adds `refresh-client
-B` subscriptions for `#{pane_pid}`, `#{pane_current_command}` and
`#{pane_current_path}` per window, and tmux pushes changes. This gives no
`argv` and needs no polling. It runs only for workspaces that have an hc
subscriber.

### Method by method

Key:

- **Y** = served by existing yaac machinery.
- **N** = needs new server work, listed after this table.
- **R** = refused with a stable error kind and a hint, because the
  operation does not exist on a yaac install.

| hc method (CLI) | yaac behavior | |
|---|---|---|
| `hello` | generation 1; `version` is the hc release whose `released.openrpc.json` we conform to (e.g. `0.1.14`), plus `+yaac.<build>` metadata; `core.id` is a permanent random id kept in the data dir (hc's `CoreInfo.id` contract), and `core.name` is the server's display name; the methods and features we implement | N |
| `server.status` (`hc server status`) | build id, uptime, counts of live and finished terminals; `holders` empty (yaac has no holder process) | Y |
| `server.stop`, `server.restart` (`hc server stop/restart`) | R `unsupported`: stopping a yaac server is `yaac server stop` or `yaac cluster stop` and never happens through a client's machine line | R |
| `terminal.run` (`hc run`) | routes on cwd, see "terminal.run routing" | N |
| `templates.list` (`hc templates`) | one template per tool yaac can launch here (`claude`, `codex`, `opencode`, `pi`), described with the default model and mode; project skills could appear as templates later | Y |
| `terminal.list` (`hc ls`) | the projection above; `all` adds stopped workspaces; label filter | Y |
| `terminal.get` (`hc get`) | one record | Y |
| `terminal.kill` (`hc kill`) | a terminal window: `POST /:id/terminals/close`. The agent window: `POST /workspace/stop`. Returns the observed result once the status watcher confirms it. | Y |
| `terminal.rm` (`hc rm`) | a stopped workspace's finished record: hidden from this user's hc view (a per-user dismissal). The workspace itself stays restartable in the web app. `workspace delete` stays a deliberate yaac action. | N |
| `terminal.keep` (`hc keep`) | stored and reported. yaac's windows live in tmux in a pod, so "lost, then restarted as a shell" corresponds to a workspace restart. `keep` on an agent window means "restart this workspace after a pod loss", and the adapter emits `lost` and `restarted` around it. | N |
| `terminal.label` (`hc label`) | client labels stored per terminal; `yaac.*` keys are read-only (error kind `invalid`) | N |
| `terminal.read` (`hc read`) | live: `capture-pane -p -J -S -<lines>` on the window. Finished: the transcript (`GET …/conversations/:sid/transcript`) rendered as text. | N |
| `terminal.attach` (`hc attach`, app panes) | a mirror viewer on the window (`window:@N` or `agent`), described below | Y+N |
| `terminal.send` (`hc send`) | agent window: `agentDriver(mode).deliverPrompt` (the tmux paste for `tui`, `session/prompt` for `acp`), the same path as `yaac-mama send`; other windows: bracketed paste plus Enter through the mirror's input path. Honours `if` (state precondition), `wait` (send, then wait) and `force`. The "quiet for about 3 s" rule is the mirror's existing input serialization plus a server-side typing timer. | N |
| `terminal.keys` (`hc keys`) | named keys become tmux `send-keys` key names, which tmux encodes for the app's current modes | N |
| `terminal.wait` (`hc wait`) | a long poll on the status store until the state is not `working`, or the window is gone; `children` waits on child workspaces (below); `output` waits for a regex in the captured screen | N |
| `terminal.interrupt` (`hc interrupt`) | `acp`: `cancel`. `tui` agent: Esc. Plain terminal: C-c. Reports the status observed afterwards. | N |
| `terminal.put` (`hc put`) | `POST /workspace/:id/attachments` (images) or `PUT /:id/upload` (other files), beside the terminal's cwd; returns the virtual path | Y |
| `machine.exec` (`hc exec`) | `POST /workspace/:id/exec {argv, cwd, env, input, timeout}`: runs one process in the pod (the driver's exec verb, k8s `exec` stream; containerless spawns in the checkout), returning exit code and output | N |
| `file.read/write/edit` (`hc file …`) | `GET/PUT /workspace/:id/file` on the translated path; `edit` is read, apply every `old`→`new` exactly once, then `PUT` with `baseVersion`, so it is all-or-nothing as hc requires | Y |
| `doc.get`, `doc.set` | a server-side versioned document store, **one namespace per user**, so each user's spaces are their own; `doc` events go to that user's subscribers | N |
| `events.subscribe` (`hc events`) | snapshot plus events derived from the snapshot hub, the status store and the tmux subscriptions; `heartbeat` every 15 s; `missed` when a subscriber's WS buffer passes the same 4 MB bound the mirror uses | N |
| `machine.add/list/connect/rename/rm` (`hc machine …`) | `machine.list` answers `[]` (yaac adds no machines of its own); the rest R `unsupported` | R |
| `rpc.discover` (`hc schema`) | the vendored `released.openrpc.json`, filtered to the methods implemented | Y |
| notifications `notes`, `$/orphaned` | `notes`: emitted to a parent workspace's agent terminal when a child workspace asks or ends (below); `$/orphaned`: never sent | N |

hc's own local commands (`hc update`, `hc connect`, `hc server start`,
`hc machine login/update`) act on the user's local core and never reach
yaac. Once `machine add` succeeds, `machine update` and `--install` are
irrelevant, because there is no binary at the far end to update.

### terminal.run routing

hc fixes the call's shape (`argv, cwd, env, labels, name, parent, keep,
wait, line, rm, timeout, …`). The adapter decides from `cwd`:

1. **A cwd inside an existing workspace** (`/yaac/<p>/<w>/…`), or labels
   carrying `yaac.workspace`: a new tmux window in that workspace, with
   `argv` (or `line`) as its command, in the translated cwd, with `env`.
   This needs `POST /workspace/:id/terminals` to take `{command, cwd, env,
   name}`. If `argv[0]` names a yaac tool, that is a second agent in the
   workspace; see the open questions.
2. **A project folder** (`/yaac/<p>`): `POST /workspace/create`.
   - `argv[0]` is the tool (`claude`, `codex`, …), and a template body, or
     the app's `task`, becomes the first prompt.
   - `name` becomes the title.
   - `labels.yaac.group` files it in a group.
   - Model, mode, permission mode and effort take the project defaults
     unless `env` carries `YAAC_MODEL` and similar.

   Creation streams progress. The adapter returns the address of a
   placeholder terminal at once. The placeholder is `live` with no pid, and
   its first paint is the progress log. When the pod is up, the placeholder
   becomes the agent window, which hc clients see as a `restarted` event,
   and they reattach. A create error ends it as `finished` with the error in
   its screen. This mirrors hc's own `spawn_pending` claim.
3. **A stopped workspace's folder** with `argv: []`: `POST /workspace/restart`.
4. **`parent` set, or a call from inside a workspace** (an agent running
   `hc run` in a pod; see below): the new workspace records that one as its
   parent. `terminal.wait {children}` and parent `notes` then work the way
   `hc`'s "agents run agents" model describes.

### Attach

`terminal.attach {terminal, cols, rows, history, observe, display}` opens a
channel bound to a pane-mirror viewer (`runtime/terminals/pane-mirror.ts`).

- **First paint** is the mirror's seed: `ESC c`, then `history` lines (at
  most the mirror's 5,000), then the screen, modes, cursor and scroll region.
  After that come the latest status as OSC 7501, the title (OSC 2), and
  `CSI ?9001l` (no pod asks for win32-input-mode).
- **Output** is the mirror's `%output` bytes with terminal queries removed.
  tmux has already answered them, which is exactly hc's contract. The
  filter in `packages/frontend/src/lib/terminal-queries.ts` moves to
  `@yaac/shared` so the browser and the server use one copy.
- **Input**: DATA bytes go through the mirror's existing input path
  (`send-keys -H`, with bracketed pastes going through `paste-buffer`).
- **Size**: RESIZE becomes the mirror's resize (`refresh-client -C @w:CxR`).
  FOCUS and FACTS count as activity, so they re-assert this viewer's size;
  that is the mirror's "latest viewer wins", which is also hc's rule.
  `observe` viewers never resize. When tmux changes the pane size, the
  adapter emits a `size` event, and the viewer renders at the size it is
  given.
- **Flow control**: the channel tracks CREDIT, and running out of credit
  is treated like the mirror's 4 MB overflow (drop the backlog, then send a
  fresh paint). This keeps one stalled app window from holding a shared
  tmux control client.
- **End**: when the window closes, the channel gets CLOSE `{reason:
  "exited"}`. When the workspace stops, it gets `{reason: "server_stop"}`.

An `acp` workspace's agent window holds acpd, which has nothing to show.
Its attach serves the conversation instead: the transcript and live
`AcpEvent`s rendered as ANSI text (a read-only chat log). Typing a line and
pressing Enter sends it as a `prompt`. This is the one place the adapter
draws, and it is deliberately plain. Until it exists, ACP workspaces attach
as `observe`-only with a one-line notice, and `hc send` and `wait` already
work for them.

## What herdr functionality yaac replaces

| herdr-core does | under yaac |
|---|---|
| spawns a local PTY per terminal and holds it in a holder process | a tmux window in a k8s pod, supervised in the pod; survives the app, the local core, and the yaac server restarting |
| `keep` restarts a fresh shell after loss | workspace restart (the checkout and conversation resume; the branch is on the server) |
| status from OSC 7501, reported by the program | yaac's status store (OSC titles and hooks for `tui`, turn boundaries and asks for `acp`); it works for every tool yaac runs with no herdr integration installed in the image |
| `hc machine add` over SSH, installing hc there | one `--via` line; no herdr binary in any pod |
| templates (agent roles) | yaac tools, models, permission modes and project skills |
| `hc exec` and `hc file` on the machine | the pod, behind yaac's egress proxy with sentinel credentials |
| documents in `docs.json` | a server table, per user, surviving pod and server restarts |
| parent/child agents | yaac-mama-spawned workspaces with a recorded parent |

## Agents inside pods calling `hc`

The hc skill (`hc --skill`) teaches agents to `hc run --bg`, `hc send`,
`hc wait --children all`, `hc read`, and to report back with `hc send` to
their parent. Add an `hc` shim to the workspace bin dir, beside `yaac-mama`.
It speaks the hc CLI and reaches `/api/hc` through the existing mama relay
(the egress proxy's relay listener, not the main listener; see
docs/server-in-cluster.md). It carries `caller` set to its own agent
terminal, held to the caller's permission mode and project scope as mama
already is. An agent that knows herdr then orchestrates yaac workspaces with
no new instructions. Children it starts are real workspaces, each with its
own pod and branch.

## Desktop app integration (a yaac mod)

herdr-app keeps its core small. Everything else is a mod: JavaScript that
can list terminals, run `hc`, and call `space.new`, `tab.new` and similar
(`defaults/herdr.d.ts`). The app works with yaac as a machine with no mod
at all, but a shipped `yaac` mod makes it first-class:

- **Spaces for workspaces.** For each yaac workspace with no space on
  machine `yaac`, create one, with folder `/yaac/<p>/<w>` and named by the
  workspace title. This covers workspaces started in the web app, by
  routines, or by `yaac-mama`. Close spaces whose workspace was deleted.
- **Commands**: "New yaac workspace" (project, tool, model and prompt
  picker, then `space.new {machine: "yaac", folder: "/yaac/<p>", argv:
  [tool], task}`), "Stop", "Restart", "Open in yaac web", "Forward port…",
  and "Allow blocked host…" (the port and host commands call yaac's HTTP API
  directly).
- **A panel** for yaac-only facts: blocked hosts, forwarded ports, the
  diff against base, and image builds.

The mod ships inside the yaac npm package, and `yaac herdr install` links
it. It is the only piece written against app-private APIs, so it is the
piece most exposed to app churn.

## New yaac work

Every route gets a `test/api/route-matrix.ts` row for both drivers.
Containerless answers the same: it has tmux windows and a checkout, and its
`exec` is a host spawn in the checkout. `/api/hc` is owner-scoped per
terminal, the same way `/pty/attach` is: readers can list, read and
observe, and only owners write.

1. **`src/api/hc/`, the protocol endpoint.** JSON-line and framed
   transport, method dispatch, the address and label registry, events
   derived from the snapshot hub and the status store, attach channels over
   the pane mirror, and documents.
2. **Schema.** New tables, each with a Drizzle migration:
   - `hc_terminals`: address, workspace, tmux window id, labels, keep,
     dismissed-by.
   - `hc_documents`: user, name, value, version.
   - `parentWorkspaceId` on the workspace row, if mama does not record it
     already.
3. **Domain and runtime verbs** the adapter needs, which also become plain
   HTTP routes so the web app and CLI can share them:
   - `deliverPrompt` exposed beyond mama (send);
   - a status-store wait;
   - window creation with command, cwd, env and name;
   - window rename;
   - capture-pane read;
   - named-key input;
   - interrupt;
   - one-shot exec in a workspace.
4. **Shared**: the terminal-query filter moves to `@yaac/shared`.
5. **CLI**:
   - `yaac hc-connect [--server]`, the pipe.
   - `yaac herdr install`: adds the machine through `hc machine add --name
     yaac --via 'yaac hc-connect'` and links the mod.
   - e2e-cli tests for every option, as CLAUDE.md requires.
6. **The in-pod `hc` shim**, plus a relay path for `/api/hc` on the mama
   relay listener.
7. **The `yaac` herdr-app mod.**
8. **Docs.** When this ships, `docs/herdr.md` replaces this plan, covering
   the protocol mapping, the version we conform to, and the virtual-path
   scheme.

## Compatibility and conformance

- **Pin a protocol version.** Vendor hc's `released.openrpc.json` at the
  version we target (currently 0.1.14, generation 1) into the server's test
  fixtures. A unit test validates every result the adapter returns against
  its JSON Schemas. hc's guarantee that the API "only grows" means a newer
  hc can call methods we lack. Those fail with JSON-RPC "method not found",
  which hc and the app already handle: the app's `check` lists the missing
  methods, and the local core forwards the error. A bump is then a
  deliberate change: copy the newer schema, then implement or refuse each
  new method.
- **`hello.version`.** The app checks the version only on its *local* core
  (`core_min`, currently 0.1.11). The local core checks only a peer's
  generation. Report the hc version whose schema we pass, so `hc machine ls`
  shows something truthful.
- **End-to-end.** A `test/e2e-containerless` file runs a pinned `hc`
  binary, downloaded by global setup next to the other pinned artefacts,
  with `machine add --via 'yaac hc-connect'` against the containerless
  server. It drives `run`, `ls`, `attach` (through `hc attach` with a
  scripted pty), `send`, `wait`, `read`, `keys`, `interrupt`, `kill`,
  `file`, `exec`, `events` and `doc` through the real core. The same file
  under `test/e2e` covers k8s, where pods add `exec` streams and the relay.
  herdr-app needs a GPU (GPUI on Vulkan or Metal), so it is verified by hand
  against a kind cluster with a `test-playwright-scripts/`-style written
  procedure.
- **Licence**: Apache-2.0 on both repos. We vendor only the schema file;
  keep its notice.

## Risks and open questions

- **Second agent in a workspace.** `hc run claude` inside an existing
  workspace folder asks for a second agent beside the first. yaac singles
  out the agent window as "the lowest index". Decide between supporting
  several agent windows in one workspace (status is already
  per-conversation) and refusing with a hint to start a child workspace.
  Refusing is cheaper and keeps one agent per pod.
- **Shared windows across users.** In `tailnet` multi-user mode, readers
  see other users' terminals. hc has no notion of read-only terminals. Send
  readers `observe`-only attaches, and refuse writes with `forbidden`.
- **Size contention** between the web app and herdr on one window is the
  mirror's existing "latest viewer wins". It matches hc's semantics, so
  nothing new is needed, but users will notice it when they run both.
- **Foreground cost.** `refresh-client -B` subscriptions per window, across
  every workspace with a subscriber, should be measured on a host with 30+
  pods before relying on them. Fall back to agent windows only if they cost
  too much.
- **App churn.** The protocol is versioned and stable. The app's
  `herdr-app` document and mod API are not promised to be. The adapter never
  reads or writes that document; only the mod touches app APIs.
- **Windows clients.** hc 0.1.14 refuses `--via` on a Windows local core
  (`check_target`: "one line, run by sh here"). Windows users would need an
  SSH target that runs `yaac hc-connect` as a forced command. That is the
  same hc protocol over a different pipe, so the endpoint does not change.
- **Upstream contact.** Nothing here needs a change upstream. It is still
  worth telling the maintainer about a third-party core implementation.
  Their AGENTS.md routes anything the app asks of the core through the
  maintainer, and we want a generation bump to be announced rather than
  discovered.

## herdr 1 (the TUI)

The herdr 1 TUI (0.9.x) is still maintained, but it is a monolith. Its
server owns local PTYs, its client protocol is private, and its only public
seam is a JSON socket API plus `pane.report_agent`. Integrating with it
would mean either a bridge that mirrors yaac into local panes running a
`yaac attach` relay, or a fork that adds a remote-pane backend at its PTY
actor. Both are worse than implementing herdr-core's public protocol, so
this plan does not pursue herdr 1. If users ask for it, the bridge
approach is the one to take.

## Milestones

1. **Spike (2–3 days).** A throwaway `/api/hc` that answers `hello`,
   `terminal.list`, `events.subscribe` (snapshot plus heartbeats) and
   `terminal.attach` over the mirror. Add it with `hc machine add --via`,
   then check `hc ls`, `hc attach yaac/tN` and the desktop app showing a
   claude TUI from a kind pod. Confirm the local core forwards
   `doc.get/set` with `on`, and that the app tolerates a machine with no
   holder.
2. **Read and write parity.** `run` (the three routes), `send`, `keys`,
   `wait`, `read`, `interrupt`, `kill`, `label`, `keep`, `doc.*`, `file.*`,
   `exec`, `put`, the status projection, the schema conformance test, and
   the containerless e2e.
3. **Agents run agents.** The in-pod `hc` shim, `parent`, `notes`, and
   `wait --children`.
4. **The app.** The `yaac` mod, `yaac herdr install`, and ACP attach
   rendering.
5. **The k8s e2e tier, and `docs/herdr.md`** to replace this plan.
