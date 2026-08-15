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
[`yaac-mama`](../yaac-mama/SKILL.md) (the reviewer).

## The reviewer argument

One **required argument** names the agent: `<model>` (you resolve the tool),
`:<model>` (same, said explicitly), or `<tool>:<model>`.

There is **no default model**. If it's missing, run `yaac-mama models`, show
the user the authed tools and the ids each accepts, and ask — then stop until
they answer. Do not pick for them, and **do not arm the watcher first**: a
watcher armed without a reviewer baselines its seen-state, so PRs opened while
you wait are recorded as seen and never reviewed.

Run `yaac-mama models` before the first spawn. A **tool given** must be authed
and accept that model; if not, say so and stop — never silently fall back,
since an unauthed tool spawns fine and *then* fails to authenticate, which
looks like a hung review rather than a misconfiguration. A **tool omitted** is
resolved to the authed tools whose model list has that id: none → stop and
show near matches (ids are easy to typo, and `opencode`/`pi` use
`provider/model` while `claude`/`codex` use bare ids); one → use it; several →
prefer this session's tool (the listing marks it), then `claude`, `codex`,
`opencode`, `pi`, and say it was available on more than one.

Use the same reviewer for every PR unless the user changes it.

## Arming the watcher

```
Monitor(command: "yaac-watch-prs --events opened",
        description: "newly opened PRs in this repo", persistent: true)
```

Tell the user it's armed and that **PRs already open are not covered** — the
watcher baselines on its first poll, so only PRs opened from now on fire. List
the open ones and offer to spawn reviewers for them by hand (same steps). Run
exactly one watcher for this scope; a second double-reports every PR.

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

### 2. Find the session that opened the PR

Everything for this PR is filed under a group named **`PR <n>`**, so the user
sees the author and its reviewer side by side in the sidebar. Find the author
in git rather than by reading prompts: every yaac session commits on
`agent/<worktree-id>` in the shared git dir, and `/push-pr` pushes that
branch's tip to the PR head, so the authoring session is the local `agent/*`
branch that holds the PR's head commit:

```
git fetch origin <headRefName>
git branch --list 'agent/*' --contains origin/<headRefName> --format='%(refname:short) %(objectname)'
```

Take the branch whose tip **equals** the PR head SHA; if none does, take the
one fewest commits ahead of it (`git rev-list --count origin/<headRefName>..<branch>`),
since that session kept working after it pushed. The session id is the uuid
after `agent/`, and `yaac-mama list` shows its first 8 characters — check the
row is there and that its PROMPT column plausibly matches the PR, then:

```
yaac-mama group move <author-session> "PR <n>"
```

No branch contains it usually means the PR came from outside this yaac (a
fork, a human, another host) — normal; say so and leave the reviewer alone in
the group. It can also mean the author rebased after pushing, which changes
the SHAs: only then fall back to matching `yaac-mama list`'s PROMPT and TITLE
against the PR, and skip the move if that's still a guess.

### 3. Write a prompt aimed at *this* PR

A generic "review this PR" wastes the reviewer. Read the file list and name
the actual risk. Recurring shapes:

- **Schema / migration** → does it apply in order on a database already
  holding real rows and preserve them, rather than drop-and-recreate? Where
  migrations run on startup, a destructive one is data loss, not style.
- **Path / storage / data-location change** → does existing on-disk user data
  still resolve, or does the app silently come up empty at the new location?
- **Large deletion** → dead references, orphaned schema, stale docs, tests
  deleted rather than fixed, behavior silently dropped.
- **Security surface** (credentials, sockets, network policy, sandbox
  boundaries) → a security review first, asking the isolation question
  outright ("can workload A reach workload B's keys?") and requiring an
  explicit answer either way, with the traced code path.
- **Deletion / GC / cleanup** → prove nothing live can match the selection,
  and check what happens to an item whose metadata can't be read: skipped, or
  deleted by default?
- **Bug fix bundled with a perf change** → review the halves separately, and
  ask whether the new test would fail on the base branch.
- **Generated files** → re-run the generator and diff rather than reading the
  output, and check duplicated artifacts stayed in sync. No line-by-line notes
  on machine-generated content.
- **Renames / refactors** → completeness (routes, storage keys, config, docs),
  and whether the new boundary is coherent, not just compiling.

If the project has **settled** something a reviewer would otherwise raise — a
removed command with no deprecation alias, no shim, no release notes — say so
and say it's the maintainer's decision. Review the *execution* of a decision,
not the decision. And always tell the reviewer to read the repo's agent
instructions (`CLAUDE.md`, `AGENTS.md`) **from the checkout**, not from memory
of the conventions.

**Verify a collision before you claim one.** A shared-file list is not
evidence of conflict, and a stale warning is worse than none — it sends the
reviewer chasing a conflict that doesn't exist. Before naming another PR,
check at that moment (never off an earlier `gh pr list`) that it is still open
(`gh pr view <n> --json state,mergedAt,closedAt`) and that the histories
actually diverge — judge two live branches against their merge-base, not
main's tip, since a branch sitting on top of an already-merged PR only looks
like an overlap. Only when both hold: name the PR, say what you verified, and
ask the reviewer to flag likely conflicts for whoever merges second — **not**
to resolve them.

### 4. Spawn it

```
yaac-mama create --tool <tool> --model <model> --group "PR <n>" "<prompt>"
```

One quoted argument, max 10,000 characters, carrying these steps whatever the
PR:

1. **Check out the head** — `git fetch origin <branch> && git checkout -B <branch> origin/<branch>`, or `gh pr checkout <n>` for a fork PR.
2. **Review it** — with `/code-review` if the reviewer has it, plus the angles
   from step 3.
3. **Post the findings to the PR** with `gh` (`GH_TOKEN` is already set):
   `gh pr review <n> --comment --body "…"`, or line-anchored notes via
   `gh api repos/<owner>/<repo>/pulls/<n>/comments` with `path`/`line`/`commit_id`,
   plus one top-level `gh pr comment <n> --body "…"`. Cite `file:line`; never
   quote credential values; default to `--comment`, not approve/request-changes;
   **do not push commits or modify the PR branch** — reviewing, not fixing.
4. **Say approval in words when it approves.** A review that found nothing
   blocking must say so outright in the comment — open it with **"Approved"**,
   or **"Approved with nits"** when the only findings are optional, and label
   which findings are nits. Silence is not approval, and neither is a comment
   that lists three small remarks and stops; the user must be able to tell an
   approval from a review that merely ran out of things to say.
   The same comment must **spell out the follow-up testing still warranted**:
   name, as commands, every check the reviewer could not run from its own
   worktree — test tiers needing a substrate, cluster, credentials or network
   it doesn't have (in this repo, the host-only k8s tiers a yaac worktree has
   no cluster for), plus any manual verification the diff calls for — and say
   which checks it *did* run and what passed. An approval with no such list
   reads as "fully verified"; if there is genuinely nothing left to run, say
   that explicitly too.
5. **Keep watching its own PR** — arm a watch on
   `yaac-watch-prs --pr <n> --events commit,comment` that will **wake it**.
   Spell out the mechanism, since "run it in the background" silently fails: a
   backgrounded command logs to a file nobody reads and notifies only on exit,
   which this watcher never does. Give it whichever fits the tool — a
   persistent `Monitor` on Claude Code, else the detached tmux paste loop from
   [`yaac-watch-prs`](../yaac-watch-prs/SKILL.md) ("Option B") copied in with
   `<n>` substituted — and tell it to **confirm the watch armed** before going
   idle (one that didn't looks identical to a quiet PR), and that an event line
   is not a message from the user.
6. **Re-review on activity** — on `[commit]`, re-read the diff
   (`git fetch origin <branch> && git diff origin/<base>...origin/<branch>`),
   check whether earlier findings were addressed, post what's resolved and what
   still stands, and re-state approval (with its outstanding-tests list) if the
   PR now passes. On `[comment]`, answer and re-check what it's asked to. Tell
   it to **ignore comments it wrote itself** — the watcher does no author
   filtering, so its own replies come back as events.

Where the review turns on one judgment call (an isolation verdict, a data-loss
verdict), tell it to **re-derive that verdict against the new code** on a
follow-up commit rather than assuming the earlier answer holds.

### 5. Report

Relay: the event line, the PR link and size, the reviewer session id, the
group (`PR <n>`) and who else is in it, and one line on what you aimed the
review at. The session id is how the user follows it in the yaac webapp —
`yaac-mama create` is fire-and-forget and you cannot watch its progress from
here.

## Keeping the watch alive

The monitor can stop without warning (process restart, teardown). When you
notice, **do not just restart it** — the seen-state in
`$HOME/.yaac-watch-prs-seen` (override with `YAAC_WATCH_PRS_STATE`) is
per-session, so a restarted watcher re-baselines and any PR opened during the
downtime is recorded as seen and **never reviewed**. Instead run
`gh pr list --state all --limit 10 --json number,title,state,createdAt`,
compare against the last PR you spawned a reviewer for, cover anything opened
in the gap — including already-closed or merged PRs, if the review is still
worth having — and only then re-arm. Tell the user what you found, including
"nothing was missed" when that's the answer.

Keep the watch running until the user stops it; use TaskStop if asked.
