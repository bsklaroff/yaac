# Slow-link terminal performance

Terminal panes and agent chat panes lag badly when the network between the
browser and the server is slow. Remote access is `tailscale serve` straight to
the server, so the WebSocket is the entire WAN path; there is no edge tier to
move. The lag is two separate physical problems:

- **RTT-bound (typing feels slow).** Every keystroke is one WS frame and
  nothing paints until tmux echoes it back. Only local prediction fixes this.
- **Bandwidth-bound (everything crawls).** The link is shared by hidden panes
  streaming full-fidelity output, full-snapshot `/events` broadcasts, a 3s
  full-diff poll, and per-event JSON envelopes on the ACP socket — with no
  compression and no flow control past the server. Foreground echo queues
  behind background redundancy.

Industry reference points, used throughout: Mosh (screen-state sync at an
RTT-adaptive rate + predictive echo), VS Code Remote (xterm.js typeahead
addon gated on measured latency; reconnect via a server-side headless
emulator's serialized state), the xterm.js flow-control guide (client ACK
watermarks), tmux ≥ 3.2 control-mode `pause-after`, sshx (predictive echo in
a browser terminal), Eternal Terminal (sequence-numbered resume).

**Transport hygiene has shipped** — WebSocket compression, `setNoDelay` on
the relay hops, output batching in the PTY bridge (which gives the
containerless driver the coalescing streamd already gave the pod path),
keystroke batching in the browser, and a ping/pong round-trip measurement
feeding an app-wide link-quality store. That is current-state now and is
described in docs/stream-relay.md ("The browser hop"), not here. It was the
absence of standard practice rather than an architecture change, and it may
resolve much of the bandwidth-bound half on its own — so re-measure with the
link-quality numbers before committing to anything below.

Plans B–E are evaluated proposals in recommended order; each stands alone.

## Plan B — stop the background contention

On a saturated link, redundant background bytes are foreground latency.
This tier deletes the redundancy. Precedent for the pane pause is tmux's own
control-mode `pause-after`.

- **Pause hidden panes.** The webapp eagerly attaches up to 12 worktrees'
  agent panes (`WorktreeView.tsx` keep-alive set) and every one streams
  full-fidelity output while invisible. Add `{type:'pause'}` /
  `{type:'resume'}` to the `/pty/attach` control vocabulary; a paused bridge
  stops reading its relay socket, so TCP backpressure propagates to streamd's
  existing PTY pause (`streamd.js` already pauses the PTY when its socket
  backs up — today that machinery can never engage because the server always
  drains eagerly). The frontend pauses panes when hidden and resumes on
  reveal. With Plan E's snapshot-on-reveal this later becomes "hidden panes
  cost zero bytes".
- **`/events` deltas.** `EventHub.publishSnapshot` (`api/events.ts`)
  broadcasts the entire server snapshot to every client on any change, with
  only a whole-string dedupe. Move to per-worktree patch events, or at
  minimum per-client interest filtering (full detail for the selected
  worktree, summary rows for the rest). The WebSocket compression already in
  place masks much of this; deltas finish it.
- **ACP stream framing.** `acp-bridge.ts` sends one JSON envelope (~70 bytes
  of framing) per projected event — batch each 150 ms tail pass into one
  array-valued frame. Send tool-call deltas instead of resending the whole
  call (with its accumulated `content[]`) on every status change. Add
  `?fromSeq=` to `/acp/attach` so reattach resumes instead of re-downloading
  the entire transcript (`seq` already exists on every event; the client
  just cannot ask). Note the chat socket is torn down whenever the pane is
  hidden, so today merely tabbing away and back replays the whole history.
- **Fix the polls.** `WorktreeChanges.tsx` fetches the full unified diff
  every 3 s — add a content-hash/ETag 304 path (or push invalidation over
  `/events`). `ImageBuildsOverlay.tsx` re-fetches the whole build log every
  1.5 s — tail from a byte offset.

## Plan C — end-to-end flow control

The documented xterm.js pattern (their flow-control guide; VS Code ships it):
the client ACKs bytes as `term.write()` callbacks fire; the server stops
reading the relay socket when unACKed bytes pass a high-water mark (~128 KB)
and resumes at a low-water mark (~16 KB). `ws.bufferedAmount` is a secondary
guard on the send side.

Today `bridge()` sends unconditionally and the client never ACKs, so a
flooding pane (`yes`, a big build) queues unbounded megabytes in the server's
WS buffer — and streamd's pod-side PTY pause never fires because the server
always drains the relay eagerly. Connecting the chain bounds memory, keeps
control frames timely, and kills "Ctrl-C takes a minute because a megabyte of
output is queued ahead of the prompt" — the exact pathology Mosh was built to
eliminate. The output batcher the bridge already runs is the natural
attachment point. The known hazard (per xterm.js's guide): a wrong watermark
or a lost ACK stalls the stream forever — the ACK protocol needs a reset on
reconnect and a test for the stall case.

## Plan D — predictive local echo (typeahead)

The only fix for RTT-bound typing lag. Port VS Code's terminal typeahead
addon (MIT, written against xterm.js): keystrokes paint immediately in a
dimmed style, are reconciled when the server echo arrives, and prediction
auto-disables when the program stops echoing predictably (password prompts,
full-screen TUIs). Activate only when the link-quality store's measured RTT
exceeds a threshold (VS Code uses 30 ms). sshx ships the same idea in a
browser terminal.

Honest expectations: this shines in `shell:*` panes and conventional line
editing; inside heavily redrawn TUI frames the addon spends much of its time
disabled — which is also VS Code's behavior and still the right trade. Do the
chat-pane analog regardless of RTT: render the user's own prompt locally on
send instead of waiting for it to round-trip through the agent log.

## Plan E — server-side screen state (Mosh's other half)

Run a headless terminal emulator per pane in the server (`xterm-headless`,
the package VS Code's server uses), consuming the pod stream at LAN speed, so
the browser syncs screen state instead of replaying the byte firehose.
Staged:

1. **Snapshot on reconnect/reveal.** Reconnect sends the serialized emulator
   state instead of spawning a new tmux view session and forcing a full tmux
   repaint — which today happens for every pane at once when the shared
   relay transport recycles (thundering herd), plus a ghost-view sweep per
   attach. Revealing a hidden pane sends one snapshot; combined with B, a
   hidden pane costs zero bytes. This is VS Code's reconnect design and most
   of the value.
2. **Collapse floods.** When C has the link paused, drop the queued bytes and
   send current serialized state on resume: a flood costs O(screen) instead
   of O(bytes) — Mosh's core insight, approximated over TCP.
3. **True diffs at an RTT-adaptive frame rate** (full Mosh SSP). Only if 1–2
   plus B–D still leave measurable pain; VS Code stops before this and is
   fine.

Costs: a few MB of server memory per pane, and emulator fidelity (mouse
modes, rare escapes) becomes a bug surface — mitigated by using it only at
reconnect/reveal/flood boundaries while live streaming stays raw bytes.

## Considered and set aside

- **WebTransport / QUIC / UDP transport** (full Mosh): kills TCP
  head-of-line blocking, but Safari support is partial, `tailscale serve`
  cannot front HTTP/3, and loss (vs. bandwidth/RTT) is not shown to be the
  dominant problem. Revisit only if jitter on lossy links remains after B–E.
- **tmux control mode as the browser transport**: would give `pause-after`
  for free, but `%output` is escaped text (bandwidth overhead) and B+C
  deliver the same pause semantics on the existing raw-byte path.
- **An edge/relay tier**: matters for globally shared sessions (sshx); for a
  single-user tailnet the server is already as close as it gets.

## Sequencing

B and C next — they share the pause/backpressure plumbing, and C's flow
control attaches to the output batcher the bridge already runs. Then D, then
E stage 1 growing toward stage 2. Re-measure the link-quality store's
round-trip numbers after each tier: the honest possibility is that B–D make E
unnecessary, as it already is that transport hygiene alone made B less
urgent than it looked.
