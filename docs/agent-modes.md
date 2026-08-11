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
runs. Only tools with an adapter in the worktree image can use `acp`
(`ACP_TOOLS` in `@yaac/shared/types`; today, claude).

The choice matters most on a phone. A chat pane is a message list and a
composer, so it needs nothing a soft keyboard can't provide; a TUI needs Esc,
Tab, Ctrl and arrows, which is why the mobile shell gives a terminal pane an
accessory key bar (`docs/mobile-layout.md`). `acp` is the mode to reach for
when the worktree will be driven from one.

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
window-close teardown, and worktree GC.

## The driver seam

`#runtime/agents` exposes `agentDriver(mode)`, returning an `AgentDriver` with
`launchCmd(spec)` and `connect(worktree, sink, deps)` — a stream of
`AgentObservation`s (`up`, `down`, `live-agents`, `status`,
`command-channel`). `WorktreeStatusWatcher` consumes it and owns what both modes
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

A pane keeps nothing of the conversation, then, but it does keep what has not
been said yet. A chat pane is torn down whenever it goes off-screen, so the
half-typed message lives in the webapp's ui store — keyed per conversation and
persisted — rather than in the pane, and returns with it.

A sent message stays in the box until the server echoes it back, so a pane torn
down inside that window restores text that may already have been delivered.
Settling that takes two answers, and they need different evidence. Whether the
box holds *the message that was sent* is an identity question: the store keeps
the exact text handed to the socket beside the draft, because comparing against
the conversation's history would clear a freshly typed "ok" on the strength of
an earlier one. Whether it arrived is a question only the replayed history can
answer. Both yes empties the box; either no leaves the text for another try.

Two events do come over the socket, because the record cannot carry them: a
turn boundary and an error, both synthesized from a `session/prompt` reply that
acpd never sees. That stays safe because the two sets are *disjoint* —
duplication needed one event with two sources, and no event has two. The tail
is flushed before either is forwarded, so a turn cannot appear to end above the
last words of the answer it ended.

Those boundaries are also the *only* thing that moves a pane's working
indicator. The messages themselves cannot be read as one, tempting as it is: a
`user` message looks like a turn beginning, but a replay is made of them —
`session/load` re-emits the whole conversation as live updates — and the record
holds no boundary to close them with. A pane inferring from content would come
back from a restart pinned at `working…`, offering a Stop button with no turn
behind it. So the pane classifies on `turn-start`, `turn-end` and `error`, plus
the busy flag its attach is greeted with, and on nothing else.

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
mid-conversation, possibly mid-turn. Three things follow.

**The handshake runs once per agent process, not per connection.** acpd's first
line on every attach is `_acpd/hello {firstAttach}`; when false, the client
skips `initialize` and `session/new` and resumes consuming notifications for
the worktree id it already holds. `firstAttach` tracks whether a client ever
*spoke*, not whether one ever connected — a client that died during an
adapter's cold start ran no handshake, and telling its successor otherwise
would send it to address a worktree that was never created.

**Busy state is recovered from the record.** ACP scopes turn state to the
request: a turn is running iff *your* `session/prompt` is unanswered, and the
protocol offers no status query, no busy notification, and no `session/load`
semantics for a turn already in progress. So a connection that takes over a
live agent cannot be told whether it is working — it reads the record instead,
which holds both directions and therefore says whether the last prompt was
ever answered. Until that resolves the conversation is *unclassified* rather
than idle, and nothing publishes a status for it: guessing `waiting` is what
paints a working agent idle. A recovered turn is announced to attached panes as
a `turn-start`, which is what lets a pane show a turn nobody there started.

**A pane outlives its connection, not its conversation.** A conversation that
is torn down takes its panes' sockets with it rather than only greying them
out. A pane holds the conversation *object* it attached to, so a replacement
registered under the same `acp:<id>` — which is what a worktree restart
produces — is invisible to it: the new conversation's boundaries go to its own
subscribers, and a Stop sent down the old socket reaches a closed peer. Closing
is what makes the pane re-attach, and re-attaching is what rebinds it.

**An in-flight `session/prompt` reply arrives as an orphan.** Its request id
belonged to the previous connection, so it is read as "that turn ended".
Request ids carry a per-connection prefix, so a *duplicate* of this
connection's own reply is told apart from a genuine orphan and dropped rather
than ending a live turn. The orphan and the record cover disjoint halves of the
same window: a reply produced while nobody was attached is never delivered
(acpd holds nothing for an absent client) and only the record has it, while a
reply that lands after the reattach beats the scan — first classification wins,
so a scan returning stale news is dropped.

## State

ACP mode adds exactly one column: `agent_sessions.mode`. A restart has to bring
a conversation back the way it was started, and nothing else on disk says which
that was.

It *removes* more than it adds. A `tui` conversation is discovered — an in-pod
hook appends a sighting and the reconciler joins recorded handles against the live
pane set. An `acp` conversation is authored: `session/new` hands the server the
id directly. No hook, no worktree-starts log, no join.

The row is still written by the reconciler's conversation sweep, and the
handshake that mints the id moves nothing the informers watch — so the id
landing in the live agent set is itself a reconcile trigger (`live-agents`,
docs/event-driven-reconcile.md). That is what the webapp waits on: until the
row exists, an ACP worktree has no chat pane to show and falls back to the
raw agent window, which is acpd's log rather than a conversation.

The pod carries `yaac.mode` as a label (stamped only for `acp`) so the status
watcher can pick a driver from an informer delta without a database read on the
pod-event hot path. Every pod without it — every TUI pod, and every pod
predating modes — reads as `tui`.

## Where status can mislead

Status is exact at turn boundaries, but three states are worth knowing.

A **hung adapter** — process alive, prompt never answered — pins the
conversation `running` indefinitely: nothing times out a `session/prompt`, and
`worktree/cancel` is a notification a wedged agent will not act on. The way out
is the pane's stop button, then a worktree restart.

A **torn record** can pin a reattached conversation `running`. Recovery reads
"last prompt unanswered" as a turn in flight, so a reply whose bytes never
landed leaves nothing to reclassify it — the agent's exit is recorded and
clears it, but a lost write is not. It shows as working with nothing
streaming, and nothing the pane can do releases it: a message queues behind
the phantom turn, and Stop's `session/cancel` names a turn the adapter does
not have, so it draws no reply. The way out is a worktree restart, which
starts a fresh acpd life and is therefore classified idle.

**Stop cancels the running turn, not the queue.** Messages sent while the agent
works queue rather than overlap, and cancelling interrupts only the turn in
flight, so stopping a backlog takes one press per message. Deliberate: a queued
prompt is input the user asked for, and a Stop aimed at the current turn
shouldn't discard it. A turn recovered after a reattach queues the same way,
even though this server never sent it.

## Capabilities yaac declines

In an editor the agent is remote from the workspace, so the client serves
`fs/*` and `terminal/*` on its behalf. Here the agent runs *inside the
container*, on the real `/workspace`, with its own tools — so yaac declines
those capabilities and the container boundary (gVisor, the egress proxy, the
NetworkPolicy) stays the one thing constraining it.

`worktree/request_permission` is always granted, matching the TUI mode's
`claude --dangerously-skip-permissions`: what constrains a yaac worktree is the
sandbox and a throwaway git worktree, not a prompt nobody is watching.

## Where things live

| Concern | Path |
|---|---|
| Driver interface + factory | `packages/server/src/runtime/agents/drivers.ts` |
| tmux driver | `packages/server/src/runtime/agents/tui-driver.ts` |
| ACP driver | `packages/server/src/runtime/agents/acp-driver.ts` |
| ACP protocol → `AcpEvent` | `packages/server/src/runtime/agents/acp-protocol.ts` |
| Record reader + tail | `packages/server/src/runtime/agents/acp-log.ts` |
| JSON-RPC peer | `packages/server/src/runtime/agents/acp-jsonrpc.ts` |
| Conversation state | `packages/server/src/runtime/agents/acp-client.ts` |
| Pane bridge (`/acp/attach`) | `packages/server/src/runtime/agents/acp-bridge.ts` |
| In-pod supervisor | `dockerfiles/acpd/` (baked into the base image) |
| Record location | `acpLogDir()` in `packages/shared/src/project-paths.ts` |
| Wire types | `packages/shared/src/acp.ts` |
| Chat pane | `packages/frontend/src/components/WorktreeChat.tsx`, `src/lib/acp.ts` |
