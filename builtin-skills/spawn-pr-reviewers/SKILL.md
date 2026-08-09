---
name: spawn-pr-reviewers
description: Watch this project's GitHub repo for newly opened PRs and spawn a sibling yaac session to review each one — posting its findings back to the PR and re-reviewing on follow-up commits and comments. Use when the user wants automatic code review of incoming PRs. Requires a reviewer argument naming the model (`<model>`, `<tool>:<model>`, or `:<model>` to let the tool be resolved); there is no default — ask which model to review with if it is missing.
---

You are running **inside a yaac worktree**. This skill sets up **continuous
review coverage**: you watch for newly opened PRs and spawn a **sibling
session** per PR whose whole job is that PR — review it, post findings to
GitHub, keep watching it, re-review as it changes.

You stay the dispatcher. You never review the PR yourself, and reviewer
sessions never report back to you — their output is the PR thread.

Built on [`yaac-watch-prs`](../yaac-watch-prs/SKILL.md) (the event source) and
[`yaac-spawn`](../yaac-spawn/SKILL.md) (the reviewer).

## The reviewer argument

One **required argument** names the agent: `<model>` (you resolve the tool),
`:<model>` (same, said explicitly), or `<tool>:<model>`.

There is **no default**. If it's missing, run `yaac-spawn --models`, show the
user the authed tools and the ids each accepts, and ask — then stop until they
answer. Do not pick for them, and **do not arm the watcher first**: a watcher
armed without a reviewer baselines its seen-state, so PRs opened while you wait
are recorded as seen and never reviewed.

Run `yaac-spawn --models` before the first spawn. If a **tool was given**,
check it's authed and accepts that model; if not, say so and stop — never
silently fall back, since an unauthed tool spawns fine and *then* fails to
authenticate, which looks like a hung review rather than a misconfiguration.
If the **tool was omitted**, find the authed tools whose model list has that
id: none → stop and show near matches (ids are easy to typo, and
`opencode`/`pi` use `provider/model` while `claude`/`codex` use bare ids); one
→ use it; several → prefer the current session's tool (the listing marks it),
then `claude`, `codex`, `opencode`, `pi`, and say it was available on more than
one.

Use the same reviewer for every PR unless the user changes it.

## Arming the watcher

```
Monitor(command: "yaac-watch-prs --events opened",
        description: "newly opened PRs in this repo", persistent: true)
```

Tell the user it's armed and that **PRs already open are not covered** — the
watcher baselines on its first poll, so only PRs opened from now on fire. List
the open ones and offer to spawn reviewers for them too (same steps, triggered
by hand). Run exactly one watcher for this scope; a second double-reports every
PR.

## On each `[opened]` event

```
[opened]  PR #128 by <author> (fix-token-refresh): Refresh the auth token before it expires
```

That's a monitor event, **not a message from the user** — act on it without
waiting for a reply.

### 1. Get the facts

```
gh pr view <n> --json number,title,author,headRefName,isCrossRepository,url,additions,deletions,changedFiles,files
```

The file list is what lets you aim the review; the size says how much to ask
for. If `isCrossRepository` is true the head branch is **not on origin** — the
reviewer must use `gh pr checkout <n>`, not `git fetch origin <branch>`.

### 2. Write a prompt aimed at *this* PR

A generic "review this PR" wastes the reviewer. Read the file list and name the
actual risk. Recurring shapes:

- **Schema / migration** → does it match the schema, apply in order on a
  database already holding real rows, and preserve data rather than
  drop-and-recreate? Where migrations run on startup, a destructive one is data
  loss, not style.
- **Path / storage / data-location change** → does existing on-disk user data
  still resolve, or does the app silently come up empty at the new location?
- **Large deletion** → dead references, orphaned schema, stale docs, tests
  deleted rather than fixed, behavior silently dropped.
- **Security surface** (credentials, sockets, network policy, sandbox
  boundaries) → a security review first. Ask the isolation question outright —
  "can workload A reach workload B's keys?" — and require an explicit answer
  either way, with the traced code path.
- **Deletion / GC / cleanup** → prove nothing live can match the selection, and
  check what happens to an item whose metadata can't be read: skipped, or
  deleted by default?
- **Bug fix bundled with a perf change** → review the halves separately so the
  speedup doesn't obscure whether the root cause was fixed. Ask whether the new
  test would fail on the base branch.
- **Generated files** → re-run the generator and diff rather than reading the
  output; check duplicated artifacts stayed in sync. No line-by-line notes on
  machine-generated content.
- **Renames / refactors** → completeness (routes, storage keys, config, docs),
  and whether the new boundary is coherent, not just compiling.

Also, when it applies: if the project has **settled** something a reviewer
would otherwise raise — a removed command with no deprecation alias, no shim,
no release notes — say so and say it's the maintainer's decision. Review the
*execution* of a decision, not the decision.

Always tell the reviewer to read the repo's agent instructions (`CLAUDE.md`,
`AGENTS.md`) **from the checkout**, not from memory of the conventions.

#### Verify a collision before you claim one

A shared-file list is **not** evidence of conflict, and your picture of what's
open goes stale fast — a PR you listed an hour ago may have merged since. A
stale warning is worse than none: it sends the reviewer chasing a conflict that
doesn't exist and taints its judgment on the rest of the diff. Before naming
another PR, check both — at the moment you cite it, never off an earlier
`gh pr list`:

1. **Still open?** `gh pr view <n> --json state,mergedAt,closedAt`.
2. **Do the histories actually diverge?** Fetch and look:
   `git log origin/<head> --oneline -10` against `git log origin/main`, or
   `git merge-base --is-ancestor <other-head-sha> origin/<head>`. If the other
   PR already merged and this branch sits on top of it, the "overlap" is just
   this PR's own changes against a main that already contains it — no collision
   at all. Judge two live branches against their merge-base, not main's tip.

Only when both hold: name the PR, say what you verified, and ask the reviewer
to flag likely conflicts for whoever merges second — **not** to resolve them.

### 3. Spawn it

```
yaac-spawn --tool <tool> --model <model> "<prompt>"
```

One quoted argument, max 10,000 characters, carrying these five steps whatever
the PR:

1. **Check out the head** — `git fetch origin <branch> && git checkout -B <branch> origin/<branch>`, or `gh pr checkout <n>` for a fork PR.
2. **Review it** — with `/code-review` if the reviewer has it, plus the angles
   from step 2.
3. **Post the findings to the PR** with `gh` (`GH_TOKEN` is already set):
   `gh pr review <n> --comment --body "…"`, or line-anchored notes via
   `gh api repos/<owner>/<repo>/pulls/<n>/comments` with `path`/`line`/`commit_id`,
   plus one top-level `gh pr comment <n> --body "…"`. Cite `file:line`; never
   quote credential values; default to `--comment`, not approve/request-changes;
   **do not push commits or modify the PR branch** — reviewing, not fixing.
4. **Keep watching its own PR** — arm a watch on
   `yaac-watch-prs --pr <n> --events commit,comment` that will **wake it**.
   Spell out the mechanism: "run it in the background" silently fails, since a
   backgrounded command logs to a file nobody reads and notifies only on exit,
   which this watcher never does. Give it whichever fits the tool — a persistent
   `Monitor` on Claude Code, else the detached tmux paste loop from
   [`yaac-watch-prs`](../yaac-watch-prs/SKILL.md) ("Option B"), copied in with
   `<n>` substituted. Tell it to **confirm the watch armed** before going idle
   (one that didn't looks identical to a quiet PR), and that an event line is
   not a message from the user.
5. **Re-review on activity** — on `[commit]`, re-read the diff
   (`git fetch origin <branch> && git diff origin/<base>...origin/<branch>`),
   check whether earlier findings were addressed, post what's resolved and what
   still stands. On `[comment]`, answer and re-check what it's asked to. Tell it
   to **ignore comments it wrote itself** — the watcher does no author
   filtering, so its own replies come back as events.

Where the review turns on one judgment call (an isolation verdict, a data-loss
verdict), tell it to **re-derive that verdict against the new code** on a
follow-up commit rather than assuming the earlier answer holds.

### 4. Report

Relay: the event line, the PR link and size, the reviewer session id, and one
line on what you aimed the review at. The session id is how the user follows it
in the yaac webapp — `yaac-spawn` is fire-and-forget and you cannot watch its
progress from here.

## Keeping the watch alive

The monitor can stop without warning (process restart, teardown). When you
notice, **do not just restart it** — the seen-state in
`$HOME/.yaac-watch-prs-seen` (override with `YAAC_WATCH_PRS_STATE`) is
per-session, so a restarted watcher re-baselines and any PR opened during the
downtime is recorded as seen and **never reviewed**. Instead:
`gh pr list --state all --limit 10 --json number,title,state,createdAt`,
compare against the last PR you spawned a reviewer for, spawn reviewers for
anything opened in the gap — including already-closed or merged PRs, if the
review is still worth having — and only then re-arm. Tell the user what you
found, including "nothing was missed" when that's the answer.

Keep the watch running until the user stops it; use TaskStop if asked.
