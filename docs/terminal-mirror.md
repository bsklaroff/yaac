# Webapp terminals: the pane mirror

The webapp shows a workspace's tmux panes in xterm.js. The browser's xterm
receives each pane's raw output and keeps the scrollback itself, so
scrolling history is local: no round trip, at any link speed. tmux stays
the process supervisor and the only terminal state; the server only carries
bytes between the two. The CLI's `workspace attach` and `workspace shell`
do not use this: a real terminal emulator owns scrollback already, so they
keep a PTY stream to a tmux client (`pty-bridge.ts`).

```
browser xterm (10,000 lines of scrollback; answers no terminal queries)
   ⇅  /api/pty/attach?target=agent|window:@<id>: size, snapshot, raw output; input back
server pane mirror (runtime/terminals/pane-mirror.ts)
   ⇅  one read-write tmux control-mode client per workspace (driver.dialCtrl)
tmux in the workspace
```

## Two kinds of scroll

Who holds the off-screen content decides where a scroll is served:

- **History scroll.** The pane is on the main screen, so lines that scroll
  off are history. Shells and dev servers render this way. The browser's
  xterm has the same history and scrolls it locally, wheel and touch alike.
- **App scroll.** The app is on the alternate screen and tracks the mouse:
  every agent TUI (claude with `CLAUDE_CODE_NO_FLICKER=1`, codex's default,
  `pi --tui-mode fullscreen`, opencode). Their transcripts exist only inside
  the app, so every wheel step is a mouse report to the app and comes back
  as a redraw. `wheel-pacing.ts` paces those reports.

Each agent has an inline mode that would put its transcript in history
instead, and each is passed over for what it loses. claude's reprints part
of the latest reply on every resize and never clears the copies, so
history fills with duplicates (anthropics/claude-code #40555, #84247).
`opencode mini` leaves tool calls and their output out of history. codex
inline (`tui.alternate_screen = "never"`) and pi's regular mode leave the
mouse to the terminal, so a collapsed tool call can no longer be clicked
open: fullscreen codex expands one on a click on its `+ N lines` row, and
fullscreen pi on a click anywhere on the call.

## Links

`terminal-links.ts` makes URLs (xterm's web-links add-on) and paths of files
in the checkout clickable, with Cmd-click on macOS and Ctrl-click elsewhere;
a plain click stays the app's, and the click forwarder never sends a
modified click to it. A path counts only if it names a file in the
checkout's listing (fetched at most every 15 s); an absolute path counts by
its longest suffix in the listing, since the checkout's absolute location
differs by driver. A file opens in the webapp's editor, at its top: the
editor takes no line number.

## The control client

The mirror dials `tmux -C attach-session -t yaac` once per workspace with a
viewer, and ends it 30 s after the last viewer leaves. It reads the stream
as latin1, one char per byte: a pane's output can split a UTF-8 character
across two `%output` lines, and the browser reassembles it from raw bytes.

The client receives `%output` for every pane in the session. A pane nobody
views is switched off (`refresh-client -A %<pane>:off`) and back on for its
next viewer. `pause-after` is not used, because with it set tmux ignores
`off`; the stream is read eagerly, so tmux never buffers for the server.

## Seeding a viewer

Each attach is seeded from tmux itself, with no emulator on the server:

1. Resolve the target to its pane (`yaac:^` is the agent window, the
   lowest index), then size its window (below).
2. One command line: `display -p` for the pane's size, cursor and the modes
   tmux exposes (alternate screen, mouse tracking and encoding, keypad
   modes, insert, wrap, origin, scroll region, cursor visibility and
   shape), and `capture-pane -p -e -J` for up to 5,000 lines of history and
   the screen. On the alternate screen it captures the normal history, the
   saved normal screen (`-a`) and the alternate screen separately.
3. Send `{"type":"size"}`, then the snapshot: a full reset (`ESC c`), the
   captured lines joined by a bare CR-LF (a capture's colours carry from
   line to line), the alternate-screen switch if on, then the scroll
   region, cursor and modes.
4. Forward the pane's output that arrived after the command line's last
   reply. tmux runs a line's commands back to back without reading pane
   output in between, so output read before that reply is already in the
   capture. `ControlModeClient.repliesSeen` counts replies as they are read,
   which is what places each `%output` line before or after the capture.

Bracketed paste is always on in a snapshot: tmux does not expose the app's
setting, and pastes go through tmux anyway (below).

A reply block ends only on the `%end` or `%error` carrying its own
`%begin`'s timestamp, number and flags, since captured pane text can start
with `%end` too.

## Input, size and flow

- **Keys** go to the pane as `send-keys -H <hex>`, in chunks. The browser's
  xterm saw the pane's own mode changes, so it already encodes keys and
  mouse reports the way the app asked.
- **Pastes** arrive bracketed (`ESC[200~…ESC[201~`) and go through
  `set-buffer` and `paste-buffer -p -r`, so tmux brackets them only if the
  app asked. The buffer text is a double-quoted tmux string with every byte
  outside printable ASCII as an octal escape, and `$` and `~` escaped
  (tmux home-expands a leading `~` even in quotes).
- **Size.** A viewer sizes its own window for the control client
  (`refresh-client -C @<window>:<cols>x<rows>`), since tiled panes differ in
  size. A control client's size for a window overrides every other client's,
  so it is held only while a browser views the window: when the last viewer
  leaves it is cleared (`refresh-client -C '@<window>:'`), and when another
  viewer remains, the latest one's size is applied. Every other window gets
  the client's default size, 80x24 unless set, so the mirror's first viewer
  also sets that default; it competes under `window-size latest` like any
  client's. Between browsers on one window the most recent to resize or
  type wins: input from a browser that is not the latest for its window
  re-applies its size. Every change to a viewed
  pane's size (`%layout-change`) is sent as `{"type":"size"}`, and the
  browser sets its grid to it without echoing a resize, since raw output
  only renders at the size the app drew it for.
- **Flood collapse.** When a viewer's WebSocket send buffer passes 4 MB,
  its output is dropped, and once the buffer drains it gets one fresh
  snapshot instead of the backlog.
- **Queries.** tmux is the app's terminal and answers its queries (device
  attributes, cursor reports, mode reports, colour queries). The browser's
  xterm drops them (`terminal-queries.ts`), or the app would get a second
  answer as typed input.

## Limits

- History older than the snapshot's 5,000 lines stays in tmux
  (`history-limit 200000`) and is not fetched.
- Modes tmux keeps but does not expose (focus reporting) come back only
  when the app sets them again.
- Sequences an app wraps in tmux's DCS passthrough reach the browser
  wrapped, and xterm ignores them; nothing in the webapp consumes them.
- A window target shows its active pane only. yaac's windows hold one pane.
- Two browsers at different sizes still share one pane size; the one not
  sizing it shows its grid at the pane's size, not its container's.
- While a browser shows a window, the browser sizes it: a CLI
  `yaac workspace attach` on the same window cannot take the size back by
  typing or resizing until no browser views it.
