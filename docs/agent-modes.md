# Agent modes: `tui` and `acp`

A yaac worktree runs a coding agent. *How* the server talks to that agent is
its **mode**, and there are two:

| | `tui` | `acp` |
|---|---|---|
| What runs | the tool's own terminal UI | the tool's ACP adapter (JSON-RPC over stdio) |
| Server sees | tmux control-mode notifications | `session/update` notifications |
| Browser sees | PTY bytes in xterm.js | structured messages in a chat pane |
| Status from | pane titles / rendered content | prompt-turn boundaries |
| Conversation ids from | the in-pod hook's session-starts log | `session/new`'s reply |

Mode is orthogonal to `AgentTool`: it selects the protocol, not which agent
runs. Only tools with an adapter in the session image can use `acp`
(`ACP_TOOLS` in `@yaac/shared/types`; today, claude).

## tmux supervises both

tmux is not a rendering choice — it is the process supervisor that outlives the
viewer. A closed tab, a dropped relay, or a restarted server must not kill a
turn in progress, and tmux is what guarantees that.

An ACP agent cannot be served that way directly: a PTY would corrupt the
protocol, and a streamd `ctrl` stream owns its child (socket close ⇒ SIGTERM),
which would put a running turn's life back on the connection. **acpd** is the
missing half — a daemon that runs *in* the tmux window, owns the agent's stdio,
and republishes it on a UNIX socket that can be attached to and detached from
freely.

```
tmux window                                   server
┌─────────────────────────────┐               ┌──────────────────┐
│ acpd ── stdio ── ACP agent  │               │ AcpConversation  │
│   └── /tmp/yaac-acp/<w>.sock│◄──ctrl+socat──┤ (JSON-RPC peer)  │
└─────────────────────────────┘               └──────────────────┘
```

So `tmux : PTY :: acpd : JSON-RPC` — one supervisor, two presentation
transports. Everything downstream of "a conversation is a tmux window" is
untouched: the launch exec, the restart that respawns what was live,
window-close teardown, and session GC.

## The driver seam

`#features/agents` exposes `agentDriver(mode)`, returning an `AgentDriver` with
`launchCmd(spec)` and `connect(session, sink, deps)` — a stream of
`AgentObservation`s (`up`, `down`, `live-agents`, `status`,
`command-channel`). `SessionStatusWatcher` consumes it and owns what both modes
need identically: respawn, backoff, and the streamd self-heal. That is why ACP
mode added no second retry loop.

Content is deliberately **not** in the interface. PTY bytes and ACP events have
nothing in common, and forcing them into one union would produce a protocol
neither side can implement honestly; the webapp already models the split, since
a pane's target string picks its renderer.

ACP's own shapes live in exactly one module (`acp-protocol.ts`), which projects
every `session/update` into the closed `AcpEvent` union. A spec change lands
there and nowhere else — not in the driver, not in the route, not in React.

## Handles

The status store keys a conversation's busy/idle by its **handle**: the
driver's address for it inside the pod — a tmux pane id (`%3`) under `tui`, the
acpd socket's window name (`claude-2`) under `acp`. The store never learns
which protocol produced a status. `worktree_agent_sessions.paneId` holds the
same handle, which is how a live status joins back to its conversation.

## Where history lives

Not in the server. acpd appends every byte it relays — both directions — to a
record on a host-mounted path, and that file *is* the conversation's history.

One choice settles several things. It is written whether or not anyone is
attached, so a turn completed with nobody watching is still recorded. It is in
ACP's own vocabulary, so replaying it runs the *same* projection the live path
does rather than a second translator that could disagree. It is on the host, so
the server reads it without going through the pod — and can still read it once
the pod is gone, which is what makes a stopped worktree's conversation readable
at all.

Both directions matter: the agent echoes a user message only when replaying
under `session/load`, so without the client's own `session/prompt` lines the
record would show no user turns for anything said live.

Because the record is the history, nothing is buffered for an absent client and
the server retains nothing.

**The record is also the only path by which content reaches a pane.** The
socket carries the RPC half — our requests and their replies, and the agent's
own questions — but not a single rendered message. That is not a preference:
the record and the socket carry the *same* `session/update` notifications, and
ACP gives notifications no identity (they are JSON-RPC notifications, so they
have no `id` by definition), which leaves nothing to join them on. Splicing two
copies of one stream at an unknown point either duplicates the overlap or drops
it. One source has no join.

So a pane's content comes from a tail of the record: the first pass delivers
everything and the pane replaces what it held, later passes deliver only what
was appended. `seq` is scoped to one attach, which is all a pane needs it for.
The cost is polling latency — a streaming reply arrives in bursts rather than
continuously, which a chat pane tolerates far better than a terminal would.

Two events do come over the socket, because the record cannot carry them: a
turn boundary and an error, both synthesized from a `session/prompt` reply that
acpd never sees. That stays safe because the two sets are *disjoint* —
duplication needed one event with two sources, and no event has two. The tail
is flushed before either is forwarded, so a turn cannot appear to end above the
last words of the answer it ended.

acpd truncates the file when it starts, which is how a new agent life
announces itself: a tail seeing the record shrink resets its position and its
projection and starts again, and the pane replaces rather than appends. A
restart's `session/load` replays the whole conversation, so the fresh file ends
up complete again rather than double-appending history it already had.

The record is named for the *conversation*, not the window: a window name is a
slot, and a restart that drops an earlier conversation shifts the later ones
down a slot, which under slot-naming would truncate one conversation's history
onto another's file. On a resume the id is known at launch; on a fresh create
the file starts under the worktree id and is renamed once `session/new`
answers.

## Reconnect

acpd keeps the agent alive across detaches, so a reconnect lands on a process
mid-conversation, possibly mid-turn. Two things follow.

**The handshake runs once per agent process, not per connection.** acpd's first
line on every attach is `_acpd/hello {firstAttach}`; when false, the client
skips `initialize` and `session/new` and resumes consuming notifications for
the session id it already holds. `firstAttach` tracks whether a client ever
*spoke*, not whether one ever connected — a client that died during an
adapter's cold start ran no handshake, and telling its successor otherwise
would send it to address a session that was never created.

**An in-flight `session/prompt` reply arrives as an orphan.** Its request id
belonged to the previous connection, so it is read as "that turn ended" — the
conservative direction, since the alternative leaves a conversation permanently
showing as busy. Request ids carry a per-connection prefix, so a *duplicate* of
this connection's own reply is told apart from a genuine orphan and dropped
rather than ending a live turn.

## State

ACP mode adds exactly one column: `agent_sessions.mode`. A restart has to bring
a conversation back the way it was started, and nothing else on disk says which
that was.

It *removes* more than it adds. A `tui` conversation is discovered — an in-pod
hook appends a sighting and the reconciler joins recorded handles against the live
pane set. An `acp` conversation is authored: `session/new` hands the server the
id directly. No hook, no session-starts log, no join.

The pod carries `yaac.mode` as a label (stamped only for `acp`) so the status
watcher can pick a driver from an informer delta without a database read on the
pod-event hot path. Every pod without it — every TUI pod, and every pod
predating modes — reads as `tui`.

## Where status can mislead

Status is exact at turn boundaries, but three states are worth knowing.

A **hung adapter** — process alive, prompt never answered — pins the
conversation `running` indefinitely: nothing times out a `session/prompt`, and
`session/cancel` is a notification a wedged agent will not act on. The way out
is the pane's stop button, then a worktree restart.

**Stop cancels the running turn, not the queue.** Messages sent while the agent
works queue rather than overlap, and cancelling interrupts only the turn in
flight, so stopping a backlog takes one press per message. Deliberate: a queued
prompt is input the user asked for, and a Stop aimed at the current turn
shouldn't discard it.

A **reattach mid-turn** shows `waiting` while the turn still runs, because the
reply belongs to the previous connection. Understating is the deliberate
direction — the alternative leaves a finished conversation busy forever.

## Capabilities yaac declines

In an editor the agent is remote from the workspace, so the client serves
`fs/*` and `terminal/*` on its behalf. Here the agent runs *inside the
container*, on the real `/workspace`, with its own tools — so yaac declines
those capabilities and the container boundary (gVisor, the egress proxy, the
NetworkPolicy) stays the one thing constraining it.

`session/request_permission` is always granted, matching the TUI mode's
`claude --dangerously-skip-permissions`: what constrains a yaac session is the
sandbox and a throwaway git worktree, not a prompt nobody is watching.

## Where things live

| Concern | Path |
|---|---|
| Driver interface + factory | `packages/server/src/features/agents/drivers.ts` |
| tmux driver | `packages/server/src/features/agents/tui-driver.ts` |
| ACP driver | `packages/server/src/features/agents/acp-driver.ts` |
| ACP protocol → `AcpEvent` | `packages/server/src/features/agents/acp-protocol.ts` |
| Record reader + tail | `packages/server/src/features/agents/acp-log.ts` |
| JSON-RPC peer | `packages/server/src/features/agents/acp-jsonrpc.ts` |
| Conversation state | `packages/server/src/features/agents/acp-client.ts` |
| Pane bridge (`/acp/attach`) | `packages/server/src/features/agents/acp-bridge.ts` |
| In-pod supervisor | `dockerfiles/acpd/` (baked into the base image) |
| Record location | `acpLogDir()` in `packages/shared/src/project-paths.ts` |
| Wire types | `packages/shared/src/acp.ts` |
| Chat pane | `packages/frontend/src/components/SessionChat.tsx`, `src/lib/acp.ts` |
