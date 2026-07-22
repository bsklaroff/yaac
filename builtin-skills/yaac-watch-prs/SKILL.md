---
name: yaac-watch-prs
description: Watch this project's GitHub repo for PR updates — newly opened PRs, new comments, or new commits — on one PR or all of them, emitting one line per event for you to act on. Use when the user asks to watch a PR (or the repo) for comments/commits/new PRs, auto-review new PRs, or drive a follow-up when a PR changes.
---

You are running **inside a yaac session**. The `yaac-watch-prs` command
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
    summary. Comments authored by the authenticated user are skipped, so your
    own replies never re-trigger it.
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

## How to run it — pair it with the Monitor tool

Because it emits one line per event, it's an ideal **Monitor** source: arm a
**persistent** Monitor whose command is the watcher, and each event line
arrives as a notification you react to. For example, to watch a specific PR
for reviewer comments:

```
Monitor(command: "yaac-watch-prs --pr <n> --events comment",
        description: "PR #<n> reviewer comments", persistent: true)
```

When a `[comment]` (or `[commit]`/`[opened]`) notification arrives, treat it
as work to act on — it is an event, not a message from the user. What you do
is up to the task: address the comment and push a fix, summarize it, spawn a
sibling session with [`yaac-spawn`](../yaac-spawn/SKILL.md), etc.

You can also run it as a plain foreground loop in a spare shell and read the
lines yourself — but the Monitor path is preferred so it doesn't block your
own work.

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
