---
name: push-pr
description: Commit pending changes on the current branch, rebase onto the latest base branch (origin/main, or another open PR's branch if this one was rebased onto it — which yields a new PR stacked on that PR, never a commit added to it), push to a new named branch on origin, open a GitHub PR against that base, then watch the PR for reviewer comments (via yaac-watch-prs) and address them as they arrive. Use when the user wants to push the current branch out as a PR. Takes an optional branch-name argument; if omitted, a descriptive name is generated from the changes.
---

You are running **inside a yaac worktree**. This skill commits any pending
work on the current branch, rebases it onto the latest base branch, pushes
it to a **new named branch on origin**, sets that branch as the current
branch's upstream, opens a GitHub PR against that base, and then **watches
the PR for reviewer comments and addresses them**. It does NOT push to `main`
itself.

The base is `origin/main` unless this branch was rebased onto another open
PR's branch, in which case the result is a new PR stacked on that one — see
the next section. Either way the outcome is a **new** PR, never a commit
added to an existing one.

It takes one **optional argument**: the origin branch name. If no name is
given, generate a short kebab-case branch name (e.g. `fix-session-cleanup`)
from the changes being pushed.

The commit message and PR title/description are always generated
automatically — they cannot be passed in. Never add AI attribution
(Co-Authored-By, "Generated with" footers, etc.) to commit messages or the PR
description.

Never use `git -C`, always just use `git` commands from the working directory.

## When this branch sits on top of another PR

A worktree is usually cut from `main`, but the work in it often isn't: a
common opening instruction is "rebase on top of PR #x, then do y", which
leaves this branch holding PR #x's commits underneath its own. When that has
happened, `/push-pr` means **open a new PR stacked on PR #x** — never add to
PR #x, and never put its commits in the new PR's diff.

Resolve the base before running the steps, from git rather than from memory
of the session:

- `git fetch origin` first, so every candidate tip and `origin/main` exist
  locally for the ancestry tests below.
- `gh pr list --state open --json number,headRefName,headRefOid --jq '.[] | [.number, .headRefName, .headRefOid] | @tsv'`
  — filter with gh's own `--jq` flag, never a `| jq` pipe: `jq` is not
  installed on every host a containerless worktree runs on, while gh's is
  built in.
- A PR is underneath this branch when its head tip is an ancestor of `HEAD`
  but not of `origin/main`:
  `git merge-base --is-ancestor <headRefOid> HEAD` succeeds and
  `git merge-base --is-ancestor <headRefOid> origin/main` fails.
- If several qualify (a deeper stack), take the one furthest from
  `origin/main` — the tip that has all the others as ancestors.

Call that PR the **base PR** and its `headRefName` the **base branch**; with
no such PR the base branch is `main`. `<base>` below means whichever it is.
Everything downstream follows from it: fetch and rebase onto `origin/<base>`,
open the PR with `--base <base>`, and count only the commits above
`origin/<base>` as this branch's own.

1. Store the current branch name.
2. Resolve `<base>` as described above, then determine the target branch name:
   - Use the argument if one was provided; otherwise generate one from the
     diff/commits about to be pushed.
   - Verify it is new: `git ls-remote --heads origin <name>`. If the branch
     already exists on origin, stop and report it — do not push over it unless
     the user explicitly asked to.
3. Check if there are any changes to commit:
   - Run: `git status --porcelain`
   - If no output, skip steps 4-5 and proceed directly to step 6.
4. Check whether this branch has a commit of its own yet, i.e. whether HEAD is
   still the base's tip:
   - Run: `git merge-base --is-ancestor HEAD origin/<base> && echo "on-base" || echo "not-on-base"`
   - When stacked, HEAD sitting on the base PR's tip means this branch has
     added nothing yet — the last commit belongs to PR #x, not to us.
5. Commit changes:
   - `git add` any untracked files that belong in the commit (`-a` alone will
     not pick them up); leave scratch and build output out.
   - If HEAD is on the base: use `git diff` to show the changes, generate a
     commit message — a one-line subject, plus a `-m "<body>"` paragraph when
     the change needs a why — and run `git commit -am "<subject>" [-m "<body>"]`.
   - If HEAD is NOT on the base: `git commit -a --amend --date=now`. Only ever
     amend a commit this branch added above `origin/<base>`; amending one that
     came from the base PR would rewrite that PR's work into ours.
6. Fetch the latest base: `git fetch origin <base>`.
7. Rebase current branch on the base: `git rebase origin/<base>`. Do not
   rebase a stacked branch onto `main` — that either conflicts or drags PR
   #x's commits into this PR's diff.
8. Push to the new branch and set it as upstream:
   - Run: `git push -u origin HEAD:<name>`
   - Always push with verification — never add `--no-verify`, so the pre-push
     hooks (e.g. tests) run.
   - Always run the push in the foreground. Do not use `run_in_background` —
     wait for the push to complete so you see the result.
9. Make plain `git push` work for future pushes: because the local branch name
   differs from the upstream branch name, the default `push.default=simple`
   would refuse to push. Run: `git config push.default upstream`.
10. Create the PR against the base:
    - Generate a title and a brief description covering the commits above
      `origin/<base>` — this branch's own work, not the base PR's. When
      stacked, open the description with "Stacked on #<base-pr-number>." so a
      reviewer knows to read that one first; GitHub retargets this PR to
      `main` by itself once the base PR merges.
    - Run: `gh pr create --base <base> --head <name> --title "<title>" --body "<description>"`
    - Report the PR URL from the output.
11. Confirm success, reporting the origin branch name and PR URL — and, when
    stacked, that this is a new PR based on the base PR rather than `main`.
12. Start watching the PR for reviewer comments. Capture the PR number
    (`gh pr view --json number --jq .number`) and arm a **persistent**
    Monitor whose command is the [`yaac-watch-prs`](../yaac-watch-prs/SKILL.md)
    watcher scoped to this PR's comments:

    ```
    Monitor(command: "yaac-watch-prs --pr <pr-number> --events comment",
            description: "PR #<pr-number> reviewer comments", persistent: true)
    ```

    - `--events comment` (not `commit`) so your own fix commits, pushed in
      step 3 of the section below, don't notify you about themselves.
    - `yaac-watch-prs` baselines on its first poll, so only comments posted
      *after* the watch starts surface. It does no author filtering: comments
      from your own account posted by the user or by sibling yaac worktrees
      surface (address them like any reviewer comment), and so do your own
      replies (recognize and ignore those — see below).
    - If the repo has no GitHub remote or the PR number can't be resolved,
      skip this step and just report the PR URL.

## Addressing comments while watching

Each `[comment] PR #… by <author>[ <loc>]: <body>` notification is a monitor
event, not a message from the user — act on it without waiting for the user.

The watcher does not filter by author, so **your own replies come back as
`[comment]` events**. Before acting on a notification, check whether it is a
comment you posted yourself earlier in this session — if so, ignore it and
keep watching; never reply to your own comment. Same-account comments you did
*not* post (the user and sibling yaac worktrees share the account) are real
events — address them like any reviewer comment.

For each notification:

1. Read the full comment and surrounding thread for context
   (`gh pr view <pr-number> --comments`, or
   `gh api repos/{owner}/{repo}/pulls/<pr-number>/comments` for the inline
   thread).
2. Decide whether it asks for a change. If it's a question or a remark that
   needs no code change, reply with an answer via
   `gh pr comment <pr-number> --body "<reply>"` and keep watching.
3. If it asks for a change, make the edit, run `pnpm lint` (and any relevant
   tests) to confirm it's sound, then commit with a generated message (adding
   any new untracked files first) and `git push` (plain push works — the
   upstream and `push.default upstream` were set above). Never add AI
   attribution to the commit.
4. Reply on the PR summarizing what you changed
   (`gh pr comment <pr-number> --body "…"`), then continue watching.

Keep the watch running until the user tells you to stop (or the session ends);
use TaskStop to end it if asked.

If anything fails, provide clear error messages and restore the original
branch.
