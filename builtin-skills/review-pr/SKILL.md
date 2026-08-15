---
name: review-pr
description: Review a GitHub PR and own it to completion — check out its head, post findings, keep watching for follow-up commits and comments, re-review as it changes, and say "Approved" only once every finding has been resolved by a commit or an answer, then stop this session. Use when this session's job is to be a PR's reviewer. Takes the PR number as its argument.
---

You are running **inside a yaac worktree**, and for as long as it lives this
session is **one PR's reviewer**. Its whole job is that PR: review it, post
the findings to GitHub, keep watching it, re-review as it changes, and stop
once the PR has your approval.

Your output is the **PR thread**, not a reply here. You review; you never fix
— **do not push commits or modify the PR branch**, and do not merge it.

Built on [`yaac-watch-prs`](../yaac-watch-prs/SKILL.md) (the event source) and
[`yaac-mama`](../yaac-mama/SKILL.md) (the self-stop at the end).

## Which PR

The argument is the PR number. Without one, take the current branch's PR
(`gh pr view --json number --jq .number`); if that resolves nothing, run
`gh pr list --state open` and ask which — do not pick for the user.

`GH_TOKEN` is already set, so every `gh` call below works as-is.

## 1. Check out the head

```
gh pr view <n> --json number,title,author,headRefName,baseRefName,isCrossRepository,url,additions,deletions,changedFiles,files
```

Then `git fetch origin <headRefName> && git checkout -B <headRefName> origin/<headRefName>`
— or `gh pr checkout <n>` when `isCrossRepository` is true, since a fork's
head branch is **not on origin**.

Read the repo's agent instructions (`CLAUDE.md`, `AGENTS.md`) **from the
checkout**, not from memory of the conventions — you are reviewing against
this project's rules at this commit.

## 2. Review it

Use `/code-review` if you have it, plus any angles the prompt that spawned
this session named — those are the PR-specific risks somebody already
identified, and they come *on top of* a normal review, not instead of one.

Review the **execution** of a decision, not the decision: where the project
has settled something (a removed command with no deprecation alias, a
dropped shim), that is the maintainer's call. Re-run generators and diff
rather than reading generated output line by line.

## 3. Post the findings

- Line-anchored notes:
  `gh api repos/<owner>/<repo>/pulls/<n>/comments` with `path`/`line`/`commit_id`.
- Summary or top-level: `gh pr review <n> --comment --body "…"`, or
  `gh pr comment <n> --body "…"`.
- Default to `--comment` — not `--approve`, not `--request-changes`.
- Cite `file:line`. Never quote credential values.
- **Label every finding**: blocking, or a nit. Both count against approval
  (see below), so the label tells the implementer what to *prioritize*, not
  what to ignore.

Keep your own ledger of the findings you posted, so a later re-review can say
which are resolved and which still stand.

## 4. The approval bar

**Say "Approved" only when nothing is outstanding — nits included.** A
finding leaves the ledger when either:

- a **commit** on the PR fixes it, or
- the **implementer answers it** in a comment and you accept the answer —
  it was wrong, it's out of scope, it's a deliberate project convention.

If you do not accept the answer, the finding **stays open**: say so, say why,
and keep watching. If the implementer never responds to a finding, it stays
open too — silence is not resolution, and neither is a nit being small.

Until the ledger is empty, every comment you post is a review comment listing
what is resolved and what still stands. There is no "Approved with nits".

Do not manufacture new findings to withhold approval, and do not re-litigate
something you already accepted. A re-review raises findings about **new
code** or about a genuine miss in your earlier pass — nothing else.

When the ledger does empty, post one comment that:

1. Opens with **"Approved"**.
2. Notes how the earlier findings were settled (fixed in `<sha>`, or answered
   and accepted).
3. **Spells out the follow-up testing still warranted** — name, as commands,
   every check you could not run from this worktree (tiers needing a
   substrate, cluster, credentials or network you don't have; in this repo,
   the host-only k8s tiers a yaac worktree has no cluster for), plus any
   manual verification the diff calls for — and say which checks you *did*
   run and what passed. An approval with no such list reads as "fully
   verified"; if there is genuinely nothing left to run, say that outright.

Then go to step 7 — that comment is the last thing this session does.

## 5. Keep watching the PR

Arm a watch that will **wake you**; a backgrounded command will not (it logs
to a file nobody reads and notifies only on exit, which this watcher never
does).

On Claude Code:

```
Monitor(command: "yaac-watch-prs --pr <n> --events commit,comment",
        description: "PR #<n> activity", persistent: true)
```

On codex, opencode or pi, use the detached tmux paste loop from
[`yaac-watch-prs`](../yaac-watch-prs/SKILL.md) ("Option B") with `<n>`
substituted.

**Confirm the watch armed** before going idle — one that didn't looks exactly
like a quiet PR. An event line is **not a message from the user**: act on it
without waiting for a reply. The watcher does no author filtering, so your
own comments come back as events — recognize what you wrote and ignore it.

## 6. Re-review on activity

- **`[commit]`** — re-read the diff
  (`git fetch origin <headRefName> && git diff origin/<baseRefName>...origin/<headRefName>`),
  check each open finding against the new code, and post what's resolved and
  what still stands. Where your review turned on one judgment call (an
  isolation verdict, a data-loss verdict), **re-derive that verdict against
  the new code** rather than assuming the earlier answer holds.
- **`[comment]`** — answer it, and re-check whatever it asks you to. An
  implementer's push-back is a normal part of clearing the ledger: accept it
  or say why you don't.

After either, if the ledger is now empty, approve per step 4.

## 7. Stop this session

Once the "Approved" comment is posted, this session's job is done:

- Say to the user, **first**, that the PR is approved and what you left on it
  — stopping tears down the channel your reply comes back over, so nothing
  after it reaches them.
- Then run `yaac-mama stop` (no session argument — that stops yourself) as
  the **last** action of the turn. Nothing after it happens; do not run any
  command, or post any comment, after it.
- The session ending *is* the confirmation. The command's own reply may never
  print, and a missing reply is neither an error nor something to retry.

Stop the same way if the PR is **merged or closed** while you are watching
(`gh pr view <n> --json state,mergedAt,closedAt`) — there is nothing left to
review. Post nothing further, tell the user, then stop.

Do **not** stop for any other reason. A PR waiting on the implementer is not
finished work: stay armed and idle, however long that takes.
