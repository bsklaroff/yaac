---
name: yaac-watch-prs
description: Watch this project's GitHub repo for newly opened PRs and spawn a sibling review session per PR, via the in-session `yaac-watch-prs` command. Use when the user asks to auto-review new PRs, watch the repo for PRs, or set up continuous PR review.
---

You are running **inside a yaac session**. The `yaac-watch-prs` command
(already on PATH) polls GitHub for newly opened PRs on this project's repo
and, for each one, spawns a **sibling review session** through
[`yaac-spawn`](../yaac-spawn/SKILL.md). Use it directly — this skill is just
the manual.

## Usage

```
yaac-watch-prs [--interval <seconds>] [--model <model>] [--prompt <text>] [--once]
```

- **`--interval`** (optional, default `60`): seconds between polls.
- **`--model`** (optional, default `claude-opus-4-8`): model the spawned
  review sessions' claude launches with (`claude --model <model>`). The
  spawned tool is always claude.
- **`--prompt`** (optional, default: invoke the `/code-review` skill on the
  PR's diff against the default branch): what the review session is told to
  do *after* checking out the PR's head branch — the checkout instruction is
  prepended automatically.
- **`--once`** (optional): a single poll instead of a loop, then exit —
  useful for a dry run or testing.

It is a **long-running foreground loop**: run it in a dedicated shell (e.g.
a separate tmux window or backgrounded with `nohup ... &`), not in a way
that blocks your own work. Output is one line per poll event; errors go to
stderr and the loop keeps running.

## What actually happens

- Each poll runs `gh pr list` from `/workspace` (repo inferred from the git
  remote, auth via this session's `GH_TOKEN`). Needs `gh` and `jq` — both in
  yaac's default session image; the command fails fast with a clear error if
  either is missing.
- Every open PR **not seen before** gets a review session: `yaac-spawn
  --tool claude --model <model>` with a prompt telling the agent to
  `git fetch origin <head-branch> && git reset --hard origin/<head-branch>`
  and then carry out the review prompt. The sibling provisions in the
  background; the printed session id is watchable in the yaac webapp.
- **Seen state** persists in `$HOME/.yaac-watch-prs-seen` (one PR number per
  line; override the path via `YAAC_WATCH_PRS_STATE`). On the **first run**
  every already-open PR is marked seen *without* spawning a review — only
  PRs opened while the watcher runs get one. Delete a number from the file
  to re-review that PR; pre-seed the file before the first run to control
  the baseline.
- **Fork PRs are skipped** with a warning: their head branch doesn't exist
  on `origin`, so the spawned session couldn't check it out.
- A PR whose spawn **fails** stays marked seen (no retry storm); remove its
  number from the state file to retry.

## Limits and caveats

- `$HOME` is per-session, so the seen state lives only as long as this
  session — a fresh watcher session re-baselines and will not re-review PRs
  that opened before it started.
- Spawns ride yaac-spawn's rate caps (at most 3 provisioning per caller); a
  burst of many new PRs in one poll drains over subsequent polls' retries
  only if you clear the failed ones from the state file — prefer a shorter
  `--interval` over huge bursts.
- The review session sees only the PR's **head branch on origin** at spawn
  time — commits pushed after the spawn are not re-reviewed.

## Guidance

- Report the watcher's startup line (interval, model, state path) to the
  user, and relay each "spawned session <id> for PR #N" line so they can
  follow the reviews in the webapp.
- Don't run more than one watcher per repo — each keeps its own seen state,
  so two watchers double-review every PR.
