# Slow-link terminal performance

Terminal panes and agent chat panes lag badly on a slow network between the
browser and the server. Remote access is `tailscale serve` straight to the
server ([remote-hosting.md](../remote-hosting.md)), so the browser's WebSocket
is the whole WAN path. There is no edge tier to move. The lag has two causes:

- **Round-trip time (typing feels slow).** Each keystroke is one WebSocket
  frame, and nothing appears until tmux echoes it back. Only local prediction
  fixes this.
- **Bandwidth (everything crawls).** Hidden panes stream full output, `/events`
  broadcasts whole snapshots, the changes view polls a full diff every 3 s,
  and the ACP socket sends one JSON envelope per event. There is no flow
  control past the server. Foreground echo waits behind all of it.

Basic transport tuning is done: WebSocket compression, `setNoDelay`, output
batching in the PTY bridge, keystroke batching in the browser, and a
round-trip measurement feeding the link-quality store. See
[stream-relay.md](../stream-relay.md) "The browser hop". Re-measure with the
link-quality numbers before starting anything below, since that tuning may
have fixed much of the bandwidth problem.

Plans B-E are in recommended order. Each stands alone.

## Plan B: stop background traffic

On a saturated link, redundant background bytes delay the foreground.

- **Pause hidden panes.** The webapp attaches up to 12 workspaces' agent panes
  up front (`EAGER_ATTACH_MAX` in `WorkspaceView.tsx`, 2 on mobile), and each
  streams full output while hidden. Add `pause` and `resume` messages to the
  `/pty/attach` control messages (today `resize`, `signal`, `ping`). A paused
  bridge stops reading its relay socket, so TCP backpressure reaches streamd,
  which already pauses the PTY when its socket backs up. That code never runs
  today, because the server always reads eagerly. The frontend pauses a pane
  when it is hidden and resumes it when shown. With Plan E's snapshot on
  reveal, a hidden pane then costs no bytes.
- **Send `/events` deltas.** `EventHub.publishSnapshot` (`api/events.ts`)
  sends the whole snapshot to every client on any change, skipping only exact
  repeats. Send per-workspace patches instead, or at least filter per client
  (full detail for the selected workspace, summary rows for the rest).
  Compression already hides much of this cost.
- **Tighten ACP framing.** `acp-bridge.ts` sends one JSON envelope per event.
  Batch each 150 ms log-tail pass (`tailAcpLog`) into one frame. Send tool-call
  changes instead of resending the whole call, with its growing `content[]`,
  on every status change. Add `?fromSeq=` to `/acp/attach` so a reattach
  resumes instead of downloading the whole transcript again. Every event
  already has a `seq`, but the client cannot ask for a starting point.
- **Fix the polls.** `useWorkspaceChanges` polls the changes route every 3 s
  while a workspace is open, with the full diff while the explorer shows it.
  Add an ETag / 304 path, or push invalidation over `/events`.
  `ImageBuildsOverlay.tsx` refetches the whole build log every 1.5 s; read
  from a byte offset instead.

## Plan C: end-to-end flow control

This is the pattern from the xterm.js flow-control guide, which VS Code uses.
The client ACKs bytes as `term.write()` callbacks fire. The server stops
reading the relay socket when unACKed bytes pass a high-water mark (about
128 KB) and resumes at a low-water mark (about 16 KB). `ws.bufferedAmount` is
a second check on the send side.

The webapp's terminals already collapse floods on the server's send buffer
([terminal-mirror.md](../terminal-mirror.md)). The CLI's PTY path,
`bridge()` in `pty-bridge.ts`, still sends without limit and the client
never ACKs. A pane printing a flood of output (`yes`, a big build) queues
megabytes in the server's WebSocket buffer, and streamd's PTY pause never
fires. Ctrl-C then takes a long time, because the prompt is queued behind
all that output. This is the problem Mosh was built to solve. Connecting the
chain bounds memory and keeps control messages timely. The bridge's output
batcher is the place to add it.

Risk: a wrong watermark or a lost ACK stalls the stream forever. The ACK
protocol needs a reset on reconnect and a test for the stall case.

## Plan D: predictive local echo (typeahead)

This is the only fix for slow typing. Port VS Code's terminal typeahead addon
(MIT-licensed, written for xterm.js). Keystrokes appear at once in a dimmed
style and are confirmed when the server's echo arrives. Prediction turns
itself off when the program stops echoing predictably (password prompts,
full-screen TUIs). Enable it only when the link-quality store's measured
round trip is above a threshold (VS Code uses 30 ms).

It works best in `shell:*` panes and normal line editing. Inside TUIs that
redraw heavily it will often be off, as it is in VS Code. For chat panes,
always do the equivalent: show the user's own prompt locally on send instead
of waiting for it to come back through the agent log.

## Plan E: server-side screen state

Stages 1-2 shipped for the webapp's terminals in the pane mirror
([terminal-mirror.md](../terminal-mirror.md)), with tmux as the screen state
rather than an emulator on the server: each attach and reconnect is one
snapshot captured from tmux, and a client that falls behind gets a fresh
snapshot instead of the backlog. What follows is the rest.

Run a headless terminal emulator per pane in the server (`xterm-headless`,
which VS Code's server uses). It reads the pod stream at LAN speed, so the
browser can sync screen state instead of replaying every byte. In stages:

1. **Snapshot on reconnect and reveal.** Today a reconnect creates a new tmux
   view session and forces a full tmux repaint, for every reconnecting pane
   at once. Send the emulator's serialized state instead. Revealing a hidden
   pane sends one snapshot. This is VS Code's reconnect design and most of
   the value.
2. **Collapse floods.** While Plan C has the link paused, drop the queued
   bytes and send the current screen on resume. A flood then costs one
   screen, not every byte. This is Mosh's core idea, approximated over TCP.
3. **True screen diffs at a frame rate adapted to round-trip time** (Mosh's
   full protocol). Only if stages 1-2 and Plans B-D still leave measurable
   lag. VS Code stops before this.

Costs: a few MB of server memory per pane, and emulator gaps (mouse modes,
rare escapes) become bugs. Using it only at reconnect, reveal and flood
boundaries, with raw bytes otherwise, limits that.

## Set aside

- **WebTransport / QUIC / UDP** (full Mosh). It removes TCP head-of-line
  blocking, but Safari support is partial, `tailscale serve` cannot front
  HTTP/3, and nothing shows packet loss is the main problem. Revisit only if
  lossy links still stutter after B-E.
- **tmux control mode as the browser transport.** `%output` is escaped
  text, which costs bandwidth. The pane mirror uses control mode only
  between pod and server and unescapes before the browser.
- **An edge or relay tier.** It helps shared sessions spread across the globe
  (sshx). For a single user on a tailnet, the server is already as close as it
  gets.

## Order

B and C first. They share the pause and backpressure plumbing, and C attaches
to the bridge's existing output batcher. Then D, then E stage 1, growing to
stage 2. Re-measure round-trip numbers after each step. B-D may make E
unnecessary.
