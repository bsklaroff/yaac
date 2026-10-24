---
name: yaac-mama
description: Ask the yaac server running this workspace to list the project's workspaces (running, queued, or stopped — searchable), start a sibling workspace with a prompt (now, or queued to start when a workspace stops or a group with a workspace limit has room), edit or discard a queued workspace, send a message to a running workspace's agent, retitle a workspace, change this workspace's base branch, stop a workspace (a sibling, or this one), restart a stopped one, file workspaces into named groups, or fetch another workspace's branches into this checkout — via the in-workspace `yaac-mama` command. Use when the user asks to spawn, fork, or kick off another yaac workspace (or "session"), queue a follow-up to run after this one (or change or drop one already queued), send/tell/nudge/steer a running workspace (or "session") with a message or follow-up instruction, farm a task out to a parallel one, see what else is running, rename/retitle a workspace, rebase this workspace's diff onto another branch (e.g. when stacking on another PR), stop/shut down/wind down a workspace or this one when its work is done, find an old or stopped workspace by what it was about, restart/revive/resume a stopped workspace, organize workspaces into groups, read what another workspace committed (its branches, log, diffs), or read another workspace's agent conversations (full session transcripts, subagents included), running or stopped.
---

You are running **inside a yaac workspace**. The `yaac-mama` command (already on
PATH) asks the host yaac server to do a small, fixed set of things in **this
same project**. Use it directly — this skill is just the manual.

## Usage

```
yaac-mama list                                    # workspaces + groups here
yaac-mama list <workspace>...                     # just those, with full prompts
yaac-mama list --stopped [--search S] [--group G] [--limit N] [--cursor C]
yaac-mama create [opts] "<prompt>"
yaac-mama queue [--parent-workspace W] [opts] "<prompt>"
yaac-mama edit-queued [--parent-workspace W | --no-parent] [opts] <queued> ["<prompt>"]
yaac-mama run-queued <queued>                       # start a queued one now
yaac-mama delete-queued <queued>                    # discard a queued one
  # opts: [--tool T] [--model M] [--effort E] [--permission-mode P] [--ui-mode U] [--branch B] [--group G] [--title T]
yaac-mama send [--conversation C] <workspace> "<message>"  # to its running agent
yaac-mama rename [<workspace>] "<title>"            # omit the workspace to rename yourself
yaac-mama set-base <branch>                         # your base branch, on origin
yaac-mama stop [<workspace>]                        # omit the workspace to stop yourself
yaac-mama restart <workspace>                       # a stopped one, resumed
yaac-mama group create "<name>"
yaac-mama group move <workspace> ["<group>"]       # omit the group to ungroup
yaac-mama group set-limit "<group>" <limit|none>   # cap how many run at once
yaac-mama models                                  # tools/models available
yaac-mama fetch <workspace>                       # its branches, into your git
yaac-mama history <workspace>                     # its conversations
yaac-mama history <workspace> <conversation>      # one's transcripts, to stdout
yaac-mama history <workspace> [<conversation>] -o <dir>   # every file, into <dir>
yaac-mama --help
```

That list is the whole surface. `yaac-mama` is a **strict subset** of the
`yaac` CLI, enforced by the server: it observes, labels, makes one new thing
(now or queued for later), messages a running one, and stops or restarts
one. Stopping is in reach precisely because it is reversible — a stopped
workspace keeps its checkout and its conversation — and restarting a
stopped one only undoes a stop, never in a more permissive mode than yours.
Nothing that has run can be deleted (only a queued workspace can be
discarded), and there is no config beyond your own base branch. If a task
needs one of those, ask the user rather than looking for a way around it.

Everything is scoped to **this workspace's project**, which is not a flag you
pass — the server resolves who is calling and answers for that project only.

## The commands

- **`list`** — every running workspace in this project, with the group each is
  filed under and the prompt it started from; your own row is marked
  `(you)`. Then a line naming the project's groups, each with its workspace
  limit if it has one (`Workers (limit 3)`). This is how you find a
  workspace id to pass to `group move`; ids print as their first 8 characters,
  and that prefix is what the other commands accept. A last line counts the
  project's stopped workspaces. `list <workspace>...` (running, queued or
  stopped ids) shows only those rows, then each one's full prompt, which the
  table cuts to 60 characters: a `Prompt of <id>:` line, then the prompt with
  every line indented two spaces. Only an unindented header line is the
  server's; a prompt's own text is always indented.

- **`list --stopped`** — this project's stopped workspaces, newest stop
  first, 25 to a page. Use it to find earlier work by what it was about,
  then read it with `history` or `fetch`, or bring it back with `restart`.
  `STOPPED` is when it stopped (UTC), and `HOW` is `stopped` for a stop
  (by you, another agent or the user) or what killed it (`oom`, `crashed`,
  `evicted`, `agent-exited`, … with the evidence after a colon).
  - **`--search <text>`**: case-insensitive substring of a title, the first
    prompt of any of its conversations, or a tool name.
  - **`--group <name>`**: only that group's (an existing group; this one
    never creates one).
  - **`--limit <n>`**: page size, 1 to 200.
  - A page with more after it ends with a `More:` line giving the exact
    command for the next one (`--cursor`, plus the options you passed).

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
  - **`--effort`**: how hard the new agent's model thinks, in the tool's own
    words (`low`, `high`, `xhigh`, opencode's `default`, …). `yaac-mama
    models` lists each model's levels and stars its default; one the model
    lacks is refused. Omitted, the project's last choice where the model has
    it, else the model's default.
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
    if it does not exist. Good for a fan-out you want kept together. A
    group with a **workspace limit** runs at most that many workspaces at
    once: a create into one that is full is refused, naming the group and
    its limit (so is a `restart` of a stopped member, or a `group move` of a
    running workspace into it). To run more than the limit, `queue` them
    with no parent instead (below).
  - **`--title`**: the label the sidebar shows for it. Omitted, it is
    titled automatically from its prompt.

- **`queue --parent-workspace <id> "<prompt>"`** — save a workspace to start
  **when a workspace stops**. Prints the queued workspace's id.
  - **`--parent-workspace`**: what it waits on — a workspace in
    this project (`"$YAAC_WORKSPACE_ID"` is this one), or a queued workspace's
    id to **chain** after it. Required, except with a limited `--group`
    (next item).
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
  - A **stopped** parent is allowed, with a note on stderr: what is queued
    under it starts only once it is restarted and then stopped again.
  - If its group is at its workspace limit when the parent stops, it waits for
    room in the group instead, and starts as soon as a slot frees.

- **`queue --group <name> "<prompt>"`** (no `--parent-workspace`) — save a
  workspace to start **once a group with a workspace limit has room**: when
  the group runs fewer workspaces than its limit, oldest queued first. It
  starts at once if there is room already. The group must already exist and
  have a limit (`group set-limit`, or the user in the webapp; `list` shows
  it); a group
  with no limit is refused (use `create`, since nothing would ever wait), and
  so is a name that matches no group (queue does not make one). Options it
  omits default as `create`'s do, and its permission mode is capped at yours.
  `list` shows these under `waiting for room in "<group>":`.

- **`edit-queued <queued> ["<prompt>"]`** — change a queued workspace before
  it starts: a prompt given replaces the stored one (omit it to keep it),
  each `create` option given replaces that setting (a new tool without a
  model takes that tool's default), `--parent-workspace` moves it under
  another parent, and `--no-parent` has it wait for room in its group
  instead (pass `--group` to move it to one; it needs a workspace limit).
  `<queued>` is its id or 8-character prefix from `list` —
  any queued workspace in this project, not only yours, so edit one you did
  not queue only when the user asked. One whose stored permission mode is
  above your own is refused until you pass a `--permission-mode` at or below
  yours — or a new `--tool`, whose permission mode is then worked out afresh,
  at or below yours. One that is already starting cannot be edited. Prints
  the result.

- **`run-queued <queued>`** — start a queued workspace **now**, whatever it
  waits on, as the user's Run now does. Refused while its group is at its
  workspace limit (it keeps waiting), and for one whose permission mode is
  above your own (lower it with `edit-queued --permission-mode` first).
  Prints the new workspace's id prefix.

- **`delete-queued <queued>`** — discard a queued workspace, as the user's
  Discard does. It cannot be undone, though nothing is lost but its prompt
  and settings. Whatever was queued after it moves up to wait on its parent
  (or, with none, waits for room in its group), so the rest of the chain
  runs one link sooner. Like `edit-queued` it takes any queued workspace
  in this project, so discard one you did not queue only when the user
  asked. One that is already starting cannot be discarded.

- **`send <workspace> "<message>"`** — hand a message to another **running**
  workspace's agent (a stopped one is refused; `restart` it first), exactly
  as if the user had typed it into its terminal or chat pane. It goes to the
  workspace's first running conversation, or the one **`--conversation`**
  names (an id or unique prefix from `history`).
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

- **`set-base <branch>`** — make `<branch>`, a branch on origin, this
  workspace's base: the branch the webapp's diff view compares it against,
  and the one a workspace you queue under it from then on forks from. Use it
  when your work builds on another PR's branch, so the diff shows only your
  own commits. It changes only that setting, never your checkout: rebase
  onto `origin/<branch>` yourself (`git fetch origin <branch>` first if your
  git does not have it yet). A branch not yet on the server's copy of origin
  is fetched for; one origin lacks is refused. Run it again with the
  default branch to undo it.

- **`stop [<workspace>]`** — end a workspace's running container (or tmux
  server): its agent stops, and its checkout, title, group and conversation
  all stay, so it can be restarted (`restart`, or the webapp). This is a
  stop, not a delete — but it is still a visible interruption, and the
  workspace's uncommitted work becomes reachable only by restarting it. **Omit the
  workspace to stop yourself**, which is the common use: a workspace spawned to
  do one job can wind itself down when the job is done. A workspace that exists
  but is not running is reported as such (or as already stopped) rather than
  as unknown.
  - **Stopping yourself is the last thing you do.** It tears down the very
    channel this command's reply comes back over, so the confirmation may
    never print — *the workspace ending is the confirmation*, and a missing
    reply is not an error and not something to retry. Commit and push
    anything worth keeping, and say whatever you need to say to the user,
    **before** you run it; nothing after it happens.

- **`restart <workspace>`** — bring a **stopped** workspace back under the
  same id, as the webapp's Restart does: its checkout as it was left, and
  the conversations that were open when it stopped, each resumed from its
  history in a window of its own. Its tool, model, effort and permission
  mode are the ones it had. Prints once the restart is under way; it then
  provisions in the background like a `create`, and shows as running in
  `list` once it is up. Its agent resumes idle — `send` it what to do next.
  - Refused for a workspace that is running (restarting it would end its
    agent's turn), for yourself, for one whose permission mode is **more
    permissive than yours** (counting a tool that lacks its mode, which comes
    back in the nearest one it has: pi only has `bypass`), for one whose tool
    the project's owner is no longer signed in to, and for one whose
    conversation history is gone from the host (the user must restore it). A
    launch that fails after the reply is shown to the user in the webapp, not
    to you; if `list` never shows it running, tell the user.

- **`group create "<name>"`** — make an empty group. Idempotent: naming one
  that already exists just resolves to it, so you never need to check first.

- **`group move <workspace> ["<group>"]`** — file a workspace under a group,
  creating the group if needed. `<workspace>` is an id or its 8-character
  prefix, from `yaac-mama list`. Omit the group entirely to return a workspace
  to the ungrouped list. Groups are how the user's sidebar is organized, so
  moving workspaces is a real, visible edit — do it when it helps them, not to
  tidy up unasked.

- **`group set-limit "<group>" <limit|none>`** — cap how many of a group's
  workspaces run or start at once; `none` removes the cap. The group must
  exist (`group create` first). Lowering it stops nothing. While the group
  is full, `create`, `restart` and `group move` into it are refused, and
  what is queued into it with no parent starts as room frees, oldest first.

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
chain waits there.

To fan out many workers but run only a few at once, make a group with a
workspace limit, then queue every worker into it with no parent:

```
yaac-mama group create "Workers"
yaac-mama group set-limit "Workers" 3
for task in …; do yaac-mama queue --group Workers "…$task…"; done
```

yaac starts the oldest waiting one whenever a worker in the group stops for
any reason, including a crash. When a queue or create is refused for its permission mode,
pass a lower `--permission-mode` rather than retrying the same request.

## Limits and errors

- Prompt: non-empty, ≤ 10,000 characters.
- At most 8 requests queued per workspace (and 32 in total), and at most 8
  workspaces you created or restarted provisioning at once — over that is
  refused with an **HTTP 422** saying so; wait and retry.
- **HTTP 422** is a server-side refusal with the reason in the text: an
  unknown command or option, a malformed `--model`, a `--permission-mode`
  more permissive than yours, a workspace id that names
  nothing in this project, a group name that matches two groups, a group at
  its workspace limit, a `queue` with no parent outside a limited group. Read the
  message — it says what to pass instead.
- **HTTP 504** (containerized workspaces) means the request timed out waiting
  for the server, and the message says which of two things happened. *"did
  not pick this up"* means nothing ran — safe to retry. *"took this request
  but never answered"* means the server had it and then died or lost the
  reply, so the command **may already have run**. `create` is not idempotent
  (every one mints a new workspace), so on that message run `yaac-mama list`
  and look for the workspace before retrying, or you will get a duplicate. The
  others are safe to repeat — a second `stop` just answers that the workspace
  is not running, and a second `restart` that it is already starting or
  running. A `stop` on yourself is the exception to all of this: no reply at
  all is the expected outcome, not a timeout to interpret.
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
- Restart a stopped workspace when the user asked, or when its own agent and
  conversation are what the work needs (to carry on where it stopped). To
  read what it did, `history` and `fetch` work on it as it is, stopped.
- Stop yourself only when the user asked, or when the prompt that spawned
  this workspace said to wind down when done. Finish first: commit, push,
  report. Never stop yourself just because you ran out of things to do —
  a workspace sitting idle costs the user nothing, and they may have a
  follow-up.
