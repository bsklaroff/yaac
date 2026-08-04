---
name: spawn-pr-reviewers
description: Watch this project's GitHub repo for newly opened PRs and spawn a sibling yaac session to review each one — posting its findings back to the PR and re-reviewing on follow-up commits and comments. Use when the user wants automatic code review of incoming PRs. Takes an optional reviewer argument (`<model>`, `<tool>:<model>`, or `:<model>` to let the tool be resolved); defaults to Fable 5.
---

You are running **inside a yaac worktree**. This skill sets up **continuous
review coverage** for a repo: you watch for newly opened PRs, and for each one
you spawn a **sibling session** whose whole job is that PR — review it, post
the findings to GitHub, then keep watching it and re-review as it changes.

You stay the dispatcher. You never review the PR yourself, and the reviewer
sessions never report back to you — their output is the PR thread.

It builds on two other shipped skills:
[`yaac-watch-prs`](../yaac-watch-prs/SKILL.md) (the event source) and
[`yaac-spawn`](../yaac-spawn/SKILL.md) (the reviewer).

## The reviewer argument

One **optional argument** names the agent to review with:

| Argument | Meaning |
|---|---|
| *(omitted)* | `claude-fable-5` — **the default** |
| `<model>` | a model id, e.g. `claude-opus-4-8` — you resolve the tool |
| `:<model>` | same as above; the empty tool says "pick one for me" explicitly |
| `<tool>:<model>` | an explicit pair, e.g. `codex:gpt-5.6-sol` |

Run `yaac-spawn --models` before the first spawn — it lists which tools have
host credentials and every model id each one accepts. Then:

- **Tool given** — check that tool is authed and accepts that model. If not,
  say so and stop. Do not silently fall back to another tool or the default: a
  tool with no host credentials spawns fine and *then* fails to authenticate,
  which looks like a hung review rather than a misconfiguration.
- **Tool omitted** — find the authed tools whose model list contains that id.
  - none → stop and report it, showing the near matches from the listing (a
    model id is easy to typo, and `opencode`/`pi` use `provider/model` ids
    while `claude`/`codex` use bare ones)
  - one → use it
  - several → pick in this order: the current session's tool (the listing
    marks it), then `claude`, `codex`, `opencode`, `pi`. Say which you picked
    and that the model was available on more than one.

Use the same reviewer for every PR in the session unless the user changes it.

## Arming the watcher

Arm a **persistent** Monitor on the watcher, scoped to newly opened PRs:

```
Monitor(command: "yaac-watch-prs --events opened",
        description: "newly opened PRs in this repo", persistent: true)
```

Then tell the user it's armed, and that **PRs already open are not covered**:
the watcher baselines its seen-state on the first poll, so only PRs opened from
now on fire. List the currently open PRs and offer to spawn reviewers for them
too — spawning a reviewer for an existing PR is the same step 1–3 below, just
triggered by hand instead of by an event.

Run exactly one watcher for this scope. A second one double-reports every PR
and you'd spawn two reviewers per PR.

## On each `[opened]` event

An event line looks like:

```
[opened]  PR #128 by <author> (fix-token-refresh): Refresh the auth token before it expires
```

It is a monitor event, **not a message from the user** — act on it without
waiting for a reply.

### 1. Get the facts

```
gh pr view <n> --json number,title,author,headRefName,isCrossRepository,url,additions,deletions,changedFiles,files
```

The changed-file list is what lets you aim the review; the size tells you how
much to ask for. If `isCrossRepository` is true the head branch is **not on
origin** — the reviewer must use `gh pr checkout <n>` rather than
`git fetch origin <branch>`.

### 2. Write a prompt aimed at *this* PR

A generic "review this PR" prompt wastes the reviewer. Read the file list and
name the actual risk in the prompt. Some recurring shapes:

- **Schema / migration change** → does the migration match the schema, apply in
  order on a database that already holds real rows, and preserve data rather
  than drop-and-recreate? Where migrations run automatically on startup, a
  destructive one is a data-loss bug, not a style note.
- **Path, storage, or data-location change** → does existing on-disk user data
  still resolve, or does the app silently come up empty at a new location?
- **Large deletion** → dead references, orphaned schema, stale docs, tests
  deleted rather than fixed, behavior silently dropped.
- **Security surface** (credentials, sockets, network policy, sandbox
  boundaries) → make it a security review first. Ask the isolation question
  outright — "can workload A reach workload B's keys?" — and require an
  explicit answer either way, with the traced code path.
- **Deletion / GC / cleanup** → prove nothing live can match the selection;
  check what happens to an item whose metadata can't be read (skipped, or
  deleted by default?).
- **Bug fix bundled with a perf change** → review the halves separately, so the
  speedup doesn't obscure whether the root cause was actually fixed. Ask
  whether the new test would fail on the base branch.
- **Generated files** → re-run the generator and diff, rather than reading the
  output; check every copy of a duplicated artifact stayed in sync. Keep the
  review proportionate — no line-by-line notes on machine-generated content.
- **Renames / refactors** → completeness (routes, storage keys, config, docs),
  and whether the new boundary is coherent, not just compiling.

Two more things worth putting in the prompt when they apply:

- **Deliberate decisions not to flag.** If the project has settled something
  the reviewer would otherwise raise — a removed command with no deprecation
  alias, no compatibility shim, no release notes — say so explicitly and say it
  is the maintainer's decision. Otherwise a good reviewer leads with all of it.
  Review the *execution* of a decision, not the decision.
- **Overlapping open PRs.** If another open PR touches the same files, name it
  and ask the reviewer to flag likely conflicts for whoever merges second —
  and not to try to resolve them.

Always tell the reviewer to read the repo's agent instructions (`CLAUDE.md`,
`AGENTS.md`) **from the checkout** rather than reviewing from memory of the
conventions; they drift.

### 3. Spawn it

```
yaac-spawn --tool <tool> --model <model> "<prompt>"
```

The prompt is one quoted argument, max 10,000 characters. Every prompt must
carry these five steps, whatever the PR:

1. **Check out the head** — `git fetch origin <branch> && git checkout -B <branch> origin/<branch>`, or `gh pr checkout <n>` for a fork PR.
2. **Review it** — with the `/code-review` skill if the reviewer has one, plus the PR-specific angles from step 2 above.
3. **Post the findings to the PR** with `gh` (`GH_TOKEN` is already set in a yaac session):
   - `gh pr review <n> --comment --body "…"`, or line-anchored notes via `gh api repos/<owner>/<repo>/pulls/<n>/comments` with `path`/`line`/`commit_id`
   - plus one top-level summary: `gh pr comment <n> --body "…"`
   - cite `file:line`; never quote credential values; **do not push commits or modify the PR branch** — it is reviewing, not fixing
   - default to a `--comment` review, not a formal approve/request-changes
4. **Keep watching its own PR** — arm a persistent Monitor on
   `yaac-watch-prs --pr <n> --events commit,comment`. Spell out that it must be
   a **persistent background monitor, not a blocking foreground command and not
   `--once`**: the event lines are what wake the agent from idle.
5. **Re-review on activity** — on `[commit]`, re-read the updated diff
   (`git fetch origin <branch> && git diff origin/<base>...origin/<branch>`),
   check whether earlier findings were addressed, and post a follow-up saying
   what is resolved and what still stands. On `[comment]`, answer questions and
   re-check what it's asked to. Tell it to **ignore comments it wrote itself** —
   the watcher does no author filtering, so its own replies come back as events.

Where the review turned on one judgment call (an isolation verdict, a
data-loss verdict), tell it to **re-derive that verdict against the new code**
on a follow-up commit rather than assuming its earlier answer still holds.

### 4. Report

Relay to the user: the event line, the PR link and size, the reviewer session
id, and one line on what you aimed the review at. The session id is how they
follow it in the yaac webapp — `yaac-spawn` is fire-and-forget and you cannot
watch its progress from here.

## Keeping the watch alive

The monitor can stop without warning (process restart, teardown). When you
notice it has stopped, **do not just restart it** — the seen-state lives in
`$HOME/.yaac-watch-prs-seen` (override with `YAAC_WATCH_PRS_STATE`), which is
per-session, so if it was lost the restarted watcher re-baselines and any PR
opened during the downtime is recorded as seen and **never reviewed**.

Instead: list recent PRs (`gh pr list --state all --limit 10 --json
number,title,state,createdAt`), compare against the last PR you spawned a
reviewer for, spawn reviewers for anything opened in the gap — including PRs
already closed or merged, if the review is still worth having — and only then
re-arm the watcher. Tell the user what you found, including "nothing was
missed" when that's the answer.

Keep the watch running until the user stops it; use TaskStop if asked.
