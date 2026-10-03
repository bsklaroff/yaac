# TUI scroll: what remains

The webapp's terminals scroll history locally (docs/terminal-mirror.md):
shells and dev servers never round-trip a scroll. Every agent TUI stays
fullscreen, so its transcript still scrolls inside the app, one wheel
report per step through the workspace. This plan covers making that
remaining case faster, and measuring it under k8s + gVisor, where it is
slowest.

## Measure first

Add a Playwright script in `test-playwright-scripts/` that times
wheel-to-paint against a k8s workspace for a shell with 20k lines of
history and each agent. Run it before and after each step below. In a
gVisor pod tmux itself answers a copy-mode scroll step in about 1 ms, so the
time is the path (browser → server → proxy → streamd → tmux → app) and the
app's own render.

## Levers for app scroll

- **Report batching.** Done as a side effect: the browser batches input for
  4 ms and the mirror sends each batch as one `send-keys`, so a frame's
  wheel reports reach the app in one read. Re-tune the pacer
  (`wheel-pacing.ts`: two reports per notch, a backlog of six) from the
  measurements.
- **claude's scroll speed.** `CLAUDE_CODE_SCROLL_SPEED` (up to 20) sets the
  lines per wheel report, with acceleration on fast spins. A higher value
  with fewer reports per notch means fewer round trips per gesture.
- **A paint glide.** On each report, offset the painted screen by a
  fraction of a cell and ease it back as the app's frame lands, so
  whole-line jumps read as motion. This is Orca's "TUI paint glide"
  (stablyai/orca PR #9339, an xterm.js patch). Cosmetic: it hides latency
  rather than removing it.
- **claude's transcript mode.** `Ctrl+o`, then `[`, writes the whole
  conversation, tool output expanded, into native scrollback until the user
  leaves it. A "scroll history" control could send those keys, so a long
  read through history scrolls locally.
- **Synchronized output under tmux.** claude probes for DEC 2026 and finds
  none under tmux 3.6, so its redraws are unsynchronized and can tear
  across frames on a slow link. A tmux release that implements mode 2026
  gives it the same protection codex and pi get from synchronized output.
