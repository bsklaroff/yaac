---
name: yaac-watch-prs
description: Watch this project's GitHub repo for PR updates — newly opened PRs, new comments, or new commits — on one PR or all of them, emitting one line per event for you to act on. Use when the user asks to watch a PR (or the repo) for comments/commits/new PRs, auto-review new PRs, or drive a follow-up when a PR changes.
---

You are running **inside a yaac worktree**. The `yaac-watch-prs` command
(already on PATH) polls this project's GitHub repo for PR updates and prints
**one line per new event to stdout**. It takes **no action itself** — you
decide what to do with each event. This skill is just the manual.

## Usage

```
yaac-watch-prs [--interval <seconds>] [--pr <number>] [--events <list>] [--once]
```

- **`--pr <number>`** (optional): watch just this PR. Default: **all open
  PRs** in the repo.
- **`--events <list>`** (optional): comma-separated subset of `opened`,
  `comment`, `commit`. Default: `opened` in all-PRs scope; `comment,commit`
  with `--pr` (a single PR can't be "opened", so that token is ignored there).
  - `opened` — a PR was newly opened (all-PRs scope only).
  - `comment` — a new top-level PR comment, inline review comment, or review
    summary. Comments from every author surface — including your own GitHub
    account, which the user and sibling yaac worktrees also post from, so
    same-account comments can still be work for you. That means your **own**
    replies come back as events too: recognize comments you yourself posted
    (you know what you wrote) and ignore them instead of responding.
  - `commit` — a new commit on a watched PR's head branch.
- **`--interval`** (optional, default `60`): seconds between polls.
- **`--once`** (optional): a single poll then exit — a dry run.

Each event is one greppable line on **stdout** (all status/errors go to
stderr, so stdout is a clean event stream):

```
[opened]  PR #<n> by <author> (<branch>): <title>
[comment] PR #<n> by <author> [<loc>]: <body>
[commit]  PR #<n> <sha> by <author>: <subject>
```

`<loc>` is a changed-file path (inline review comment) or a review state
(`APPROVED`/`CHANGES_REQUESTED`/…); it's absent for a top-level comment.

## How to run it — the watcher must be able to *wake* you

Between polls you are idle, and an idle agent resumes only when input
arrives — so the watcher must be wired to something that delivers each line
to you.

**The trap:** an ordinary backgrounded command (`yaac-watch-prs … &`, or a
background-exec tool) does *not* wake you. Its stdout goes to a log nobody
reads, and a background job notifies on **exit** — which this watcher never
does. A foreground run blocks you instead; `--once` polls once and is gone.

### Option A — a harness event tool

Claude Code has a persistent `Monitor`, which turns each stdout line into a
notification:

```
Monitor(command: "yaac-watch-prs --pr <n> --events comment",
        description: "PR #<n> reviewer comments", persistent: true)
```

It is the only one of yaac's four tools with one. codex, opencode and pi offer
external control surfaces instead (`codex remote-control`, `opencode
serve`/`attach`, `pi --mode rpc`), and all need the agent run as a server or
daemon — yaac runs every tool as a TUI in tmux, so those three use Option B.

### Option B — paste into your own agent pane (any harness)

Anything in the session can type into the agent's tmux window; it is how yaac
delivers a session's initial prompt (`promptPasteScript` in
`agent-command.ts`). Pipe the watcher into a detached paste loop, and each
event lands in your input box and submits.

```sh
SOCK=/tmp/yaac-tmux/server                      # CONTAINER_TMUX_SOCK
WIN=$(tmux -S "$SOCK" list-windows -t yaac -F '#{window_name}' | head -1)
setsid nohup sh -c '
  yaac-watch-prs --pr <n> --events commit,comment |
  while IFS= read -r line; do
    printf %s "$line" | tmux -S '"$SOCK"' load-buffer -b yaac-ev -
    tmux -S '"$SOCK"' paste-buffer -p -d -b yaac-ev -t yaac:'"$WIN"'
    tmux -S '"$SOCK"' send-keys -t yaac:'"$WIN"' Enter
  done
' > /tmp/yaac-watch.log 2>&1 < /dev/null &
```

`setsid nohup … &` with the redirects is what outlives the call that armed it;
`paste-buffer -p` keeps a multi-line body from submitting line by line; the
window is named for the tool, so discover it rather than hardcoding. The
watcher's stderr lands in `/tmp/yaac-watch.log` if a watch goes quiet.

Events arrive as ordinary input, so **they look exactly like the user typing**.
Treat an `[opened]`/`[comment]`/`[commit]` line as an event to act on, with
nobody awaiting a reply — push a fix, summarize it, spawn a sibling session
with [`yaac-spawn`](../yaac-spawn/SKILL.md), whatever the task calls for.

## What actually happens

- Each poll runs `gh` from `/workspace` (repo inferred from the git remote,
  auth via this session's `GH_TOKEN`). Needs `gh` and `jq` — both in yaac's
  default session image; the command fails fast if either is missing. There
  are **no yaac-specific dependencies** — it's pure `gh`/`jq`.
- **Seen state** persists in `$HOME/.yaac-watch-prs-seen` (override the path
  via `YAAC_WATCH_PRS_STATE`), keyed per event so each comment/commit/PR
  fires at most once. On the **first run** every current PR/comment/commit is
  recorded as seen *without emitting* — only updates that land while the
  watcher runs are surfaced. Delete a key from the file to re-emit it.
- `$HOME` is per-session, so the seen state lives only as long as this
  session — a fresh watcher re-baselines.
- **A poll whose `gh` calls fail is skipped, not reported as "no events".**
  If GitHub is unreachable the watcher notes each failure on stderr and
  retries on the next poll rather than emitting anything. So silence on
  stdout means "nothing new *or* currently blind" — if a watch matters and
  has gone quiet for a long time, check the monitor's output for those
  stderr notes. The first pass is likewise retried until it completes, so an
  outage at startup can't turn into a flood of stale events on recovery.

## Auto-reviewing new PRs

To reproduce a continuous PR-review setup, watch `opened` events and spawn a
review session per PR yourself: arm `Monitor(command: "yaac-watch-prs
--events opened", persistent: true)`, and on each `[opened] PR #<n> …`
notification run `yaac-spawn --tool claude` with a prompt that checks out the
PR's head branch (`git fetch origin <branch> && git reset --hard
origin/<branch>`) and invokes `/code-review`. Keeping the spawn on your side
(rather than baked into the watcher) lets you decide the tool, model, and
prompt per event — and skip fork PRs, whose head branch isn't on `origin`.

## Guidance

- Relay the watcher's startup line (scope, interval, events, state path) and
  each event line to the user so they can follow along.
- Don't run more than one watcher over the same scope — each keeps its own
  seen state, so two watchers double-report every event.
