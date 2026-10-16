# How restored ACP history differs from the live pane

An `acp` conversation's chat pane shows acpd's record of the current agent
life as it streams. Once the agent restarts, or the workspace stops, what
came before that life is read back from the tool's own history (claude's
transcript, codex's rollouts, pi's session log) and translated into the
events the pane renders (docs/agent-modes.md, "Pages and compaction"). That
translation is also what a `tui` conversation's transcript shows. opencode
is the exception: its `session/load` replays the whole conversation, so its
earlier lives are that replay, as the record holds it.

The translators aim to reproduce what the live pane showed, but a tool's
files do not keep everything the ACP stream carried, and some keep things
the stream never sent. This lists every known difference, so a gap is a
recorded decision rather than a surprise. Each entry says what differs and
why. The translators' module comments (`packages/server/src/runtime/agents/*-acp-replay.ts`)
describe how each one maps the tool's history; this doc is the list of what
that mapping cannot bring back.

## Every tool

- **Turn outcomes.** A turn's end and an error reach the live pane over the
  socket, built from the `session/prompt` reply. No history holds them, the
  record included, so an unusual stop reason (`max_tokens`, `refusal`,
  `cancelled`) and an adapter error show only while the pane that saw them
  stays open.
- **Queued messages.** A message waiting for the turn to end lives in the
  server's memory and is dropped at a stop. Only one that was sent shows in
  the history.
- **A page break where the current life began.** The tool's history before
  the life and the record of it are paged separately, so a page ends there.
  Earlier restarts leave no break: the tool's history is one stream, and a
  life read back from it continues the page it lands on.
- **History past the transcript cap.** The history before the life is read
  only up to the life's start, under the 64 MB transcript cap. Past it, the
  record's `session/load` replay stands in, which claude and pi send only
  from their latest compaction, so the turns before that are not shown.

## claude

- **Permission asks.** claude's transcript does not keep the ask or the
  answer. A refused call shows as a failed tool call with claude's refusal
  text.
- **Mid-turn messages.** claude keeps a message steered into a running turn as
  an ordinary user message, so it shows where claude took it, without the
  "sent mid-turn" marker, and it ends the turn before it in the view.
- **Subagents and background tasks.** claude reports these live through Agent
  SDK task messages its transcript does not keep. They are rebuilt from the
  calls that launched them and from the `<task-notification>` messages that
  reported them (`AcpProjection.replayedLaunch`), so a task or subagent that
  reported nothing before the restart shows as ended: a subagent cancelled,
  a task stopped. A subagent's own messages come from its separate
  transcript. Past the transcript cap, the adapter's `session/load` replay
  sends no notifications at all, so a task or background subagent it
  rebuilds shows as ended even when it finished, and no run shows what woke
  it.
- **Quoted notification markup.** A message whose text quotes a
  `<task-notification>` block after other text shows without the block,
  since the adapter's history reader strips that markup.

## codex

- **Permission asks and plan approval.** Only an ACP client has these
  exchanges; the rollout keeps neither.
- **Command output.** codex persists a command once it ends, so its output
  arrives as one block at the end rather than streaming.
- **Mid-turn messages** show where codex took them, not when they were sent.
- **Proposed plans** follow the message they end instead of splitting it.
- **Not persisted at all:** a command or wait still running when the
  workspace stopped, warnings and notices, a plan set from code mode's `exec`
  cell, and TUI slash commands (`/review`, `/compact`) as user messages.
- **Compactions** show without a summary, live and restored alike: codex
  keeps none a reader can show.

## pi

- **Edits.** A restored edit shows one diff block per hunk of pi's recorded
  patch, and a write the whole file as new. Live, pi-acp diffs the file
  before and after on disk.
- **Compactions** show their summary and the tokens before them, but not
  whether they were asked for or automatic, which pi's log does not say.
- **Shown only when restored:** a branch summary, an extension's visible
  message, and a user's `!` command, which pi's TUI shows and pi-acp does not
  send.
- **Not restored:** entries off the active branch, hidden extension
  messages, labels and session names.

## opencode

In an `acp` conversation, earlier lives are opencode's `session/load`
replay, which sends each message's text, reasoning and tool calls, and its
compactions, and nothing else:

- **The `/compact`** that asked for a compaction is not replayed; the
  compaction itself is.
- **Subagents' own messages** are not replayed; the call that spawned each
  one is.
- **A user's `!` command** is not replayed.
- **Permission asks** are not replayed.
- **A turn opencode starts itself** reaches neither the record nor the live
  pane, but its messages are in opencode's history, so the replay shows them.

A `tui` conversation's transcript is read from opencode's database:

- **Permission asks.** opencode does not persist them.
- **Slash commands** show as the text they expanded into, not the
  `/command` typed. opencode stores only the expansion.
- **Failed steps.** A failed step's error arrives live as the prompt's reply,
  which opencode does not store.
- **Edit diffs** show the changed hunks and their context. Live, opencode
  diffs the whole file as it is on disk, which its history does not hold.

## Adding an entry

Add an entry here, under the tool it concerns or under "Every tool", in the
same change that finds or causes the difference: a translator that drops
something, an adapter upgrade that streams something new, a bug report of a
conversation that looked different after a restart. Say what differs and
why. When a change closes a gap, delete its entry.
