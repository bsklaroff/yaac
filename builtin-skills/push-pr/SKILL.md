---
name: push-pr
description: Commit pending changes on the current branch, rebase onto latest origin/main, push to a new named branch on origin, open a GitHub PR, then watch the PR for reviewer comments (via yaac-watch-prs) and address them as they arrive. Use when the user wants to push the current branch out as a PR. Takes an optional branch-name argument; if omitted, a descriptive name is generated from the changes.
---

You are running **inside a yaac worktree**. This skill commits any pending
work on the current branch, rebases it onto the latest `origin/main`, pushes
it to a **new named branch on origin**, sets that branch as the current
branch's upstream, opens a GitHub PR against `main`, and then **watches the
PR for reviewer comments and addresses them**. It does NOT push to `main`
itself.

It takes one **optional argument**: the origin branch name. If no name is
given, generate a short kebab-case branch name (e.g. `fix-session-cleanup`)
from the changes being pushed.

The commit message and PR title/description are always generated
automatically — they cannot be passed in. Never add AI attribution
(Co-Authored-By, "Generated with" footers, etc.) to commit messages or the PR
description.

Never use `git -C`, always just use `git` commands from the working directory.

1. Store the current branch name.
2. Determine the target branch name:
   - Use the argument if one was provided; otherwise generate one from the
     diff/commits about to be pushed.
   - Verify it is new: `git ls-remote --heads origin <name>`. If the branch
     already exists on origin, stop and report it — do not push over it unless
     the user explicitly asked to.
3. Check if there are any changes to commit:
   - Run: `git status --porcelain`
   - If no output, skip steps 4-5 and proceed directly to step 6.
4. Check if the current HEAD commit exists on origin/main:
   - Run: `git merge-base --is-ancestor HEAD origin/main && echo "on-main" || echo "not-on-main"`
5. Commit changes:
   - `git add` any untracked files that belong in the commit (`-a` alone will
     not pick them up); leave scratch and build output out.
   - If HEAD is on origin/main: use `git diff` to show the changes, generate a
     commit message — a one-line subject, plus a `-m "<body>"` paragraph when
     the change needs a why — and run `git commit -am "<subject>" [-m "<body>"]`.
   - If HEAD is NOT on origin/main: `git commit -a --amend --date=now`.
6. Fetch latest main: `git fetch origin main`.
7. Rebase current branch on origin/main: `git rebase origin/main`.
8. Push to the new branch and set it as upstream:
   - Run: `git push -u origin HEAD:<name>`
   - Always push with verification — never add `--no-verify`, so the pre-push
     hooks (e.g. tests) run.
   - Always run the push in the foreground. Do not use `run_in_background` —
     wait for the push to complete so you see the result.
9. Make plain `git push` work for future pushes: because the local branch name
   differs from the upstream branch name, the default `push.default=simple`
   would refuse to push. Run: `git config push.default upstream`.
10. Create the PR against main:
    - Generate a title and a brief description summarizing the changes.
    - Run: `gh pr create --base main --head <name> --title "<title>" --body "<description>"`
    - Report the PR URL from the output.
11. Confirm success, reporting the origin branch name and PR URL.
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
