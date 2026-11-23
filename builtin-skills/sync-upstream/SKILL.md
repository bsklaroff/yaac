---
name: sync-upstream
description: Catch a fork up with its upstream — rebase the fork's commits onto the upstream's new tip, resolve conflicts, and push to origin with --force-with-lease — or bring a branch only the upstream has into the fork. Use when the user asks to sync, update or catch up the fork (or "this repo") with upstream, or to rebase a branch onto the upstream.
---

You are running **inside a yaac workspace** whose repo may be a **fork**: its
`origin` is the repo workspaces push to, and its **upstream** is the repo its
history comes from. The server keeps `upstream/*` in this checkout current
(within minutes of the upstream), so you never need to add a remote. The
`upstream` remote can be fetched but never pushed to.

**First, check this repo has an upstream.** If `git config --get
remote.upstream.url` prints nothing, this repo is no fork: tell the user the
skill does not apply here (they can give the repo an upstream with `yaac repo
upstream <repo> <upstream>` on their machine, or in Settings → Repos), and
stop.

**In a workspace with several repos**, each repo sits in its own folder under
the workspace dir (`$YAAC_CHECKOUTS` lists them, colon-separated): `cd` into
the folder of the repo to sync and run every command from there.

## The rule: the fork rebases

A fork's default branch is the upstream's history with the owner's commits on
top, and catching up keeps it that way: the owner's commits are replayed onto
the upstream's new tip, never merged. So `upstream/main..main` is always
exactly what the fork adds, as a straight list of commits.

## Bringing the fork up to date

Here `main` stands for the default branch (`git symbolic-ref --short
refs/remotes/origin/HEAD`, minus `origin/`).

1. Fetch both remotes: `git fetch origin && git fetch upstream`. The
   upstream fetch goes through yaac's read-only grant; if it fails, the
   `upstream/*` the server copied in are still recent enough to use.
2. Check out `main` at origin's tip: `git switch -C main origin/main` if
   this checkout is on another branch with no work of its own; otherwise
   commit or stash first.
3. See what is coming: `git log --oneline main..upstream/main` (the
   upstream's new commits) and `git log --oneline upstream/main..main` (what
   the fork adds). If the first is empty, the fork is current: say so and
   stop.
4. Rebase: `git rebase upstream/main`. Resolve each conflict so the fork's
   commit keeps its intent on the new code, `git add` the files, and `git
   rebase --continue`. Build and run the project's tests if they are quick,
   since a clean rebase can still break the build.
5. Push: `git push --force-with-lease=main:<old origin/main sha> origin
   main`. The lease makes the push fail rather than drop a commit someone
   pushed to origin meanwhile.
   - A yaac-hosted fork's default-branch guard lets this rewrite through only
     while its owner allows rebasing onto the upstream (on by default), and
     only when every one of the fork's commits survives with the same patch.
     If the push is refused ("cannot be force-pushed", or "drops or changes
     the fork's own commits", which a conflict resolution causes), fall back
     to a merge: `git reset --hard <old origin/main sha>`, `git merge
     upstream/main`, resolve, and `git push origin main` (a fast-forward).
     If the refusal named the setting, tell the user it is off ("Allow
     rebasing onto the upstream" in Project settings, or `yaac config
     upstream-rebase <project> on`).
   - On a fork hosted elsewhere, a refusal comes from that host's branch
     protection: report it and stop.
6. **Name the workspaces left on the old commits.** Every workspace cut
   from the old `main` still sits on the fork's old commits, which its
   Changes pane now counts as its own. Run `yaac-mama list` and tell the
   user which running workspaces of this project are affected; each needs
   `git rebase origin/main` (git drops the old copies of the fork's
   commits, since the same patches are on the new base). Offer to send them
   that instruction with `yaac-mama send`.

## A feature branch

Rebase onto whichever base the work calls for: `git rebase upstream/main`
to build on the upstream's latest directly, or `git rebase origin/main` to
build on the fork. Push with `--force-with-lease` to origin.

## A branch only the upstream has

Bring it into the fork by pushing it to origin:
`git push origin upstream/<branch>:refs/heads/<branch>`.
