---
name: yaac-mama
description: Ask the yaac server running this workspace to list the project's workspaces, start a sibling workspace with a prompt (now, or queued to start when a workspace stops), edit a queued workspace's prompt or settings, send a message to a running workspace's agent, retitle a workspace, stop a workspace (a sibling, or this one), file workspaces into named groups, or fetch another workspace's branches into this checkout — via the in-workspace `yaac-mama` command. Use when the user asks to spawn, fork, or kick off another yaac workspace (or "session"), queue a follow-up to run after this one (or change one already queued), send/tell/nudge/steer a running workspace (or "session") with a message or follow-up instruction, farm a task out to a parallel one, see what else is running, rename/retitle a workspace, stop/shut down/wind down a workspace or this one when its work is done, organize workspaces into groups, read what another workspace committed (its branches, log, diffs), or read another workspace's agent conversations (full session transcripts, subagents included), running or stopped.
---

You are running **inside a yaac workspace**. The `yaac-mama` command (already on
PATH) asks the host yaac server to do a small, fixed set of things in **this
same project**. Use it directly — this skill is just the manual.

## Usage

```
yaac-mama list                                    # workspaces + groups here
yaac-mama create [opts] "<prompt>"
yaac-mama queue --parent-workspace W [opts] "<prompt>"
yaac-mama edit-queued [--parent-workspace W] [opts] <queued> ["<prompt>"]
  # opts: [--tool T] [--model M] [--permission-mode P] [--ui-mode U] [--branch B] [--group G] [--title T]
yaac-mama send [--conversation C] <workspace> "<message>"  # to its running agent
yaac-mama rename [<workspace>] "<title>"            # omit the workspace to rename yourself
yaac-mama stop [<workspace>]                        # omit the workspace to stop yourself
yaac-mama group create "<name>"
yaac-mama group move <workspace> ["<group>"]       # omit the group to ungroup
yaac-mama models                                  # tools/models available
yaac-mama fetch <workspace>                       # its branches, into your git
yaac-mama history <workspace>                     # its conversations
yaac-mama history <workspace> <conversation>      # one's transcripts, to stdout
yaac-mama history <workspace> [<conversation>] -o <dir>   # every file, into <dir>
yaac-mama --help
```

That list is the whole surface. `yaac-mama` is a **strict subset** of the
`yaac` CLI, enforced by the server: it observes, labels, makes one new thing
(now or queued for later), messages a running one, and stops one. Stopping
is in reach precisely because it is reversible — a stopped workspace keeps
its checkout and its conversation, and the user can restart it. There is no
delete, no restart, no config. If a task needs one of those, ask the user
rather than looking for a way around it.

Everything is scoped to **this workspace's project**, which is not a flag you
pass — the server resolves who is calling and answers for that project only.

## The commands

- **`list`** — every running workspace in this project, with the group each is
  filed under and the prompt it started from; your own row is marked
  `(you)`. Then a line naming the project's groups. This is how you find a
  workspace id to pass to `group move`; ids print as their first 8 characters,
  and that prefix is what the other commands accept.

- **`create "<prompt>"`** — start a **new sibling workspace** in this project
  and deliver the prompt to its agent. Prints the new workspace's id on stdout
  and exits 0, so `id=$(yaac-mama create "…")` works.
  - **`--tool`**: `claude`, `codex`, `opencode`, or `pi`. Omitted, it
    defaults to this workspace's own tool, then the project default, then
    `claude`. **Run `yaac-mama models` before choosing** — a tool with no
    host credentials still spawns, and its agent then fails to authenticate.
  - **`--model`**: any model id the chosen tool accepts — an id or alias for
    claude/codex (e.g. `opus`), `provider/model` for opencode and pi (e.g.
    `anthropic/claude-opus-5`), where the provider must be the one that tool
    is authed for. There is no fixed list yaac enforces, only a shape check,
    so a typo'd id spawns and fails at the vendor.
  - **`--permission-mode`**: how much the new agent may do before it asks —
    `bypass`, `auto`, `accept-edits`, `manual` or `plan`, most permissive
    first. Omitted, it **inherits this workspace's own** (or, when the tool
    lacks that one, the most permissive it has below it). You can grant a
    sibling **at most your own permission mode**: asking for a more
    permissive one is refused with an error, never quietly lowered. So is
    one the tool lacks (pi has only `bypass`; codex under `--ui-mode acp` has no
    `manual` or `plan`).
  - **`--ui-mode`**: `acp` (a chat pane in the yaac webapp) or `tui` (the
    agent's own terminal UI). Omitted, it is this workspace's own.
  - **`--branch`**: the branch on origin the new workspace starts from.
    Omitted, origin's default branch. Push a branch first to hand a
    sibling work from here. A branch that is not on origin is not caught
    here: the id comes back and the workspace then fails to provision.
  - **`--group`**: file the new workspace in this group, creating the group
    if it does not exist. Good for a fan-out you want kept together.
  - **`--title`**: the label the sidebar shows for it. Omitted, it is
    titled automatically from its prompt.

- **`queue --parent-workspace <id> "<prompt>"`** — save a workspace to start
  **when a workspace stops**. Prints the queued workspace's id.
  - **`--parent-workspace`** (required): what it waits on — a workspace in
    this project (`"$YAAC_WORKSPACE_ID"` is this one), or a queued workspace's
    id to **chain** after it.
  - Takes every option `create` does. The ones it omits default from the
    parent — its tool, current model, UI mode, permission mode, group, and the
    branch it forked from (the child starts from that branch's *latest* tip
    on origin, not from this workspace's commits: push, and name your branch in
    the prompt, to hand work over). The permission mode is stepped down to
    your own when the parent's is more permissive; naming one above yours is
    refused.
  - It starts only on a **natural stop** — `yaac-mama stop` or the user
    stopping the workspace. A workspace that crashes, runs out of memory, or
    whose agent simply exits does **not** start what is queued after it; that
    waits in the sidebar for the user.
  - `list` shows what is queued, indented under what it waits on.

- **`edit-queued <queued> ["<prompt>"]`** — change a queued workspace before
  it starts: a prompt given replaces the stored one (omit it to keep it),
  each `create` option given replaces that setting (a new tool without a
  model takes that tool's default), and `--parent-workspace` moves it under
  another parent. `<queued>` is its id or 8-character prefix from `list` —
  any queued workspace in this project, not only yours, so edit one you did
  not queue only when the user asked. One whose stored permission mode is
  above your own is refused until you pass a `--permission-mode` at or below
  yours — or a new `--tool`, whose permission mode is then worked out afresh,
  at or below yours. One that is already starting cannot be edited. Prints
  the result.

- **`send <workspace> "<message>"`** — hand a message to another **running**
  workspace's agent, exactly as if the user had typed it into its terminal or
  chat pane. It goes to the workspace's first running conversation, or the
  one **`--conversation`** names (an id or unique prefix from `history`).
  - An agent mid-turn is not interrupted: a chat-pane (`acp`) agent folds it
    into the turn or queues it, and a terminal (`tui`) agent's own UI queues
    what is typed while it works. Anything its user left unsent in the input
    box is set aside and put back afterwards. A terminal agent showing a
    dialog (a permission prompt, say) cannot take it: the send fails with
    "not delivered" and nothing is typed. Try again later. So does a claude
    one whose user has both a stashed prompt and a draft holding a paste or
    an image, which only the stash keeps whole. If your message itself makes
    the agent ask for permission, the draft stays set aside until its user
    answers: in claude's stash, codex's history (Up) or opencode's stash, or,
    for a claude user who also had a stash, only in claude's kill ring
    (Ctrl+Y). Mention that to the user if you know they were typing.
  - The reply says the message was handed over, not that it was answered.
    Read the answer with `yaac-mama history <workspace> <conversation>`.
  - The conversation may run in **at most your own permission mode**:
    messaging a more permissive one is refused, as is messaging yourself. A
    terminal agent reports a mode its user changes only with its next
    prompt, so the check follows from then on.
  - One message at a time: while one of yours is being delivered, or one
    to the same conversation, another is refused; send it once the first
    returns.
  - It arrives headed `Sent from <your workspace id> via yaac-mama:`, so the
    agent knows who is asking and can `send` back. Otherwise write it
    self-contained, like a `create` prompt; control characters are dropped.

- **`rename [<workspace>] "<title>"`** — set the label the sidebar shows in
  place of a workspace's id. **Omit the workspace to rename yourself**, which is
  the common use: once you know what this workspace is actually doing, say so,
  and the user can see it without opening the workspace. Titles are trimmed,
  whitespace-collapsed and capped at 120 characters; the reply tells you what
  was stored. Renaming a sibling works the same way.

- **`stop [<workspace>]`** — end a workspace's running container (or tmux
  server): its agent stops, and its checkout, title, group and conversation
  all stay, so the user can restart it from the webapp. This is a stop, not a
  delete — but it is still a visible interruption, and the workspace's
  uncommitted work becomes reachable only by restarting it. **Omit the
  workspace to stop yourself**, which is the common use: a workspace spawned to
  do one job can wind itself down when the job is done. A workspace that exists
  but is not running is reported as such rather than as unknown.
  - **Stopping yourself is the last thing you do.** It tears down the very
    channel this command's reply comes back over, so the confirmation may
    never print — *the workspace ending is the confirmation*, and a missing
    reply is not an error and not something to retry. Commit and push
    anything worth keeping, and say whatever you need to say to the user,
    **before** you run it; nothing after it happens.

- **`group create "<name>"`** — make an empty group. Idempotent: naming one
  that already exists just resolves to it, so you never need to check first.

- **`group move <workspace> ["<group>"]`** — file a workspace under a group,
  creating the group if needed. `<workspace>` is an id or its 8-character
  prefix, from `yaac-mama list`. Omit the group entirely to return a workspace
  to the ungrouped list. Groups are how the user's sidebar is organized, so
  moving workspaces is a real, visible edit — do it when it helps them, not to
  tidy up unasked.

- **`models`** — which agent tools have host credentials (with kind and
  provider) and each one's accepted model ids. The workspace cannot see host
  credentials itself, so this is the only way to know what is usable.

- **`fetch <workspace>`** — copy another workspace's branches and HEAD into
  this checkout's git, as `refs/yaac/peers/<id8>/<branch>` and
  `refs/yaac/peers/<id8>/HEAD`, and print the refs it wrote. Works on a
  stopped workspace as well as a running one (the id comes from `list`, or
  from whoever told you about it). After that, ordinary git reads it:
  `git log yaac/peers/<id8>/HEAD`, `git diff HEAD...yaac/peers/<id8>/HEAD`,
  `git for-each-ref --contains <sha> refs/yaac/peers/`. Only **committed** work travels — not
  its uncommitted changes, stash or config. Run it from inside this
  checkout. Fetching again replaces that workspace's refs; nothing is ever
  written to the other workspace.

- **`history <workspace>`** — read another workspace's agent conversations,
  running or stopped, as the tools themselves wrote them. Nothing is written
  to the other workspace.
  - With no conversation it **lists** them: the conversation id, tool, mode
    (`tui` or `acp`), whether its agent is running (for a stopped workspace:
    was, when it stopped), model, last activity, how many files it left and
    their size, and its opening message.
  - **`history <workspace> <conversation>`** prints its JSONL transcripts to
    stdout, the main one first and then each subagent's (a claude subagent's
    transcript, a codex `spawn_agent` child or fork). The conversation is its
    id from the listing or a unique prefix. Pipe it to `jq`, `grep` or a file.
    Lines are the tool's own format: claude, codex and pi each write
    different JSON.
  - **`-o <dir>`** saves every file instead, of the one conversation or of
    all of them, as `<dir>/<conversation>/…`, and prints the paths written.
    That adds what a transcript only points at (claude's saved tool results
    under `<conversation>/tool-results/`) and, for an `acp` conversation,
    yaac's verbatim record of it as `acpd.jsonl`.
  - opencode keeps a workspace's history in one SQLite database. Each opencode
    conversation hands out a copy of it as `opencode.db`, which `yaac-mama`
    turns into JSONL with `python3`: one line per message
    (`{"session", "type", "seq", "time", "data"}`), the conversation first,
    then each subagent's session (under `subagents/` with `-o`). The copy
    holds every opencode conversation of that workspace; query it with
    Python's `sqlite3` module for anything else. On a containerized workspace it is
    the checkpoint opencode's pod refreshes every five minutes and at stop,
    so a running one's newest turns may be missing.
  - A running agent may be mid-write, so the last line of a live transcript
    can be cut short.

## What actually happens on `create`

- **Fire-and-forget.** The id comes back *before* provisioning finishes; the
  create runs detached and takes tens of seconds. You cannot watch progress
  from here — the user follows it in the yaac webapp.
- **The sibling shares nothing with this workspace.** It gets a fresh checkout
  branched from origin's default branch (or `--branch`) — it does not see this
  workspace's uncommitted changes, env, or conversation. Write the prompt
  self-contained; if the new workspace must build on work from here, commit and
  push a branch first and tell the prompt to fetch and check it out.

## Queueing a follow-up

The main use of `queue` is "when I'm done, pick up from here": queue the
follow-up, finish your work (commit, push, report), then `yaac-mama stop`
yourself as your last act — that stop is what starts it. For a multi-step
plan whose steps must run one after another, chain them:

```
a=$(yaac-mama queue --parent-workspace "$YAAC_WORKSPACE_ID" "step 2: …")
yaac-mama queue --parent-workspace "$a" "step 3: …"
```

A chain moves on only when each link's agent calls `yaac-mama stop` (or the
user stops it) — tell each link's prompt to stop itself when done, or the
chain waits there. When a queue or create is refused for its permission mode,
pass a lower `--permission-mode` rather than retrying the same request.

## Limits and errors

- Prompt: non-empty, ≤ 10,000 characters.
- At most 8 requests queued per workspace (and 32 in total), and at most 8
  spawn-started workspaces provisioning at once per caller — over that is an
  **HTTP 429**; wait and retry.
- **HTTP 422** is a server-side refusal with the reason in the text: an
  unknown command or option, a malformed `--model`, a `--permission-mode`
  more permissive than yours, a workspace id that names
  nothing in this project, a group name that matches two groups. Read the
  message — it says what to pass instead.
- **HTTP 504** (containerized workspaces) means the request timed out waiting
  for the server, and the message says which of two things happened. *"did
  not pick this up"* means nothing ran — safe to retry. *"took this request
  but never answered"* means the server had it and then died or lost the
  reply, so the command **may already have run**. `create` is not idempotent
  (every one mints a new workspace), so on that message run `yaac-mama list`
  and look for the workspace before retrying, or you will get a duplicate. The
  others are safe to repeat — a second `stop` just answers that the workspace
  is not running. A `stop` on yourself is the exception to all of this: no
  reply at all is the expected outcome, not a timeout to interpret.
- "cannot reach the yaac proxy" / "cannot reach the yaac server" means the
  path itself is broken — report it to the user rather than retrying.

## Guidance

- Don't spawn in a loop or fan out workspaces unless the user asked for that
  scale — each workspace is a whole agent working in its own checkout.
- After spawning, report the printed workspace id(s) and note that the workspace
  is provisioning in the background (visible in the yaac webapp).
- Prefer `yaac-mama list` over guessing what else is running; it is cheap and
  it is the only view you have of your siblings.
- Stop a sibling when the user asked or when work you started there is
  finished — not to tidy up unasked. It interrupts a whole agent mid-turn,
  and any work it had not committed is only reachable by restarting it.
- Stop yourself only when the user asked, or when the prompt that spawned
  this workspace said to wind down when done. Finish first: commit, push,
  report. Never stop yourself just because you ran out of things to do —
  a workspace sitting idle costs the user nothing, and they may have a
  follow-up.
