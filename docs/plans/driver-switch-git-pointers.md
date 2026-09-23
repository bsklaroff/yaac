# Git pointers across a driver switch

## Problem

A linked checkout's git plumbing is two absolute paths, and both live in the
data dir:

- `global/projects/<slug>/worktrees/<id>/.git`: `gitdir: <admin dir>`
- `global/projects/<slug>/repo/.git/worktrees/<id>/gitdir`: `<checkout>/.git`

Each substrate writes them in its own view. Under k8s, `buildWorktreeLinkExec`
rewrites both inside the pod, to `/repo/.git/worktrees/<id>` and
`/workspace/.git`. `/workspace` and `/repo/.git` are read-write hostPath
mounts, so the rewrite is saved into the data dir (confirmed in a live
worktree). Under containerless, `addWorktree` writes host paths, and the link
step is skipped because the workspace sees the checkout at its host path.

The skip came in with the containerless driver (def6003e), and its only reason
was "nothing to re-point on a fresh host create".

| Switch | What happens on restart |
|---|---|
| containerless → k8s | Heals. Every k8s launch re-runs the in-pod rewrite, because `/workspace` ≠ `worktreeDir(…)`. |
| k8s → containerless | Breaks. The skip leaves pod paths in place, so the agent's `git` in the host checkout follows `.git` to a `/repo/…` that doesn't exist on the host. |

The server's own git calls are unaffected either way: they pass
`--git-dir`/`--work-tree` explicitly (`listCheckoutFiles` and friends) and
never read the pointers.

No other path-shaped git state reaches the data dir. The pod's
`~/.gitconfig` (with `safe.directory /workspace`) is pod-local, the
containerless per-workspace gitconfig lives in its state dir, and the repo
config holds only remotes and branch upstreams.

## Fix

Run the link step on every create and restart, on both drivers. In
`launchWithSetup` (`#domain/worktrees` create.ts), delete the
`paths.workspaceDir !== worktreeDir(…)` guard and its comment:

```ts
await runtime.exec(jobName, buildWorktreeLinkExec(worktreeId, paths))
```

`buildWorktreeLinkExec` is already written against `WorkspacePaths`, so under
containerless it writes host paths (`paths.repoGitDir`, `paths.workspaceDir`)
through the driver's host exec. That's a local shell, milliseconds, and
`assertShellSafePaths` has already vetted the paths. On a fresh containerless
create it rewrites `addWorktree`'s values with themselves, except that git's
realpath form (macOS `/private/var/…`) becomes the logical one. Both resolve,
and `addWorktree` already writes the admin `gitdir` in logical form. The
`locked` file it rewrites is the same content `addWorktree` wrote.

This is a net deletion. The rule becomes "a checkout's pointers are always in
the view of the substrate launching it", written at every launch. The one
conditional disappears, and so does the one comment explaining it.

Also update:

- `docs/containerless-driver.md` ("the create path skips the in-pod gitdir
  rewrite entirely") and the `buildWorktreeLinkExec` doc comment, which still
  says it runs "inside the pod".
- `repo.ts`'s `worktree repair` comment: "Every worktree yaac has ever started
  has exactly such a `gitdir`" becomes "every worktree last started under
  k8s".

## Precondition, not solved here: the outgoing substrate must be down

The rewrite points the checkout at the new substrate's view, so a workspace
still running on the old one loses git the moment the new one restarts that
worktree. A k8s Job left running after `yaac server start` on the host is one
example; host tmux sessions left running after `yaac cluster install` are the
other. That is the smaller half of a problem the switch already has: two
agents in one checkout. Neither server can see the other substrate's
workspaces, so the switch procedure has to stop them. State that in the
switch docs, wherever the switch procedure is documented. It needs no code
here.

## Known gap: submodules

A submodule initialized inside a workspace gets a `.git` file and a
`core.worktree` with paths *relative* to that workspace's view (`/workspace/…`
against `/repo/.git/worktrees/<id>/modules/…`). The host layout nests those
directories differently, so the same relative string resolves elsewhere after
a switch. Out of scope unless projects with submodules turn up. If they do,
the link step can re-point them the same way, by running
`git submodule foreach` after the rewrite.

## Tests

- **test/e2e-containerless** (runnable in a dev worktree): stop a worktree,
  plant the k8s shape (`.git` → `gitdir: /repo/.git/worktrees/<id>`, admin
  `gitdir` → `/workspace/.git`), restart it, and assert that `git status`
  succeeds through the workspace exec and that both files now hold host
  paths. Add it to an existing restart file rather than creating a new
  fixture.
- **test/e2e (k8s, host-only)**: the mirror case. Plant host-shaped pointers
  (any absolute path outside the pod), restart, and assert `git status` in
  the pod. This pins the direction that already works today so it can't
  regress.
- **Manual, once, on a host with a cluster:** create and stop a worktree under
  k8s, stop the Deployment, run `yaac server start` on the same data dir,
  restart the worktree and run `git status` inside it; then go back the other
  way. This is the only check that runs a real switch rather than a planted
  one.
