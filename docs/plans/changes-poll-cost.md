# The changes poll on a network filesystem

The webapp polls `/changes` every 3 seconds while the explorer is open
(docs/file-editor.md). Each poll runs the changes script
(`#drivers/shared` `workspace-changes.ts`) in the workspace. The script walks
the whole working tree: `git add -A` into a private index `lstat`s every
file, and a `full` listing walks again for ignored entries and untracked
folders. On a byo install the checkout is on `yaac-nfs`. It is mounted
with file attributes cached for up to a minute and a gVisor dentry cache
large enough for the tree, which together take most `lstat`s off the
network (docs/nfs-checkout-performance.md, measured on a single host). On
`infra/hetzner-k3s` a run took seconds before those settings, and opening
the changes view waits up to two of them: the rest of the poll already
running, then its own.

This plan measures what is left on a real network first, then tries the
cheap git-side cuts that apply either way.

## 1. Measure

On a Hetzner workspace with a realistic checkout (dependencies installed,
a few dozen changed files), time each part of the script against the
private index the poll keeps warm (`/tmp/yaac-changes.idx` in the pod):

```sh
cd /workspace
export GIT_INDEX_FILE=/tmp/yaac-changes.idx
time git -c core.checkStat=minimal add -A --ignore-errors      # the stat walk
time git ls-files -z --others --ignored --exclude-standard --directory >/dev/null
time git ls-files -z --others --exclude-standard --directory >/dev/null
time git diff --cached "$(git merge-base origin/main HEAD)" >/dev/null  # the body
unset GIT_INDEX_FILE
```

Run each twice, once right after a poll and once after 5 seconds idle, to
see how much the attribute cache saves. Then time the whole request
(`curl -w '%{time_total}' '<origin>/api/workspace/<id>/changes?diff=1&listing=full'`)
to see what is left for the exec transport. Repeat on node disk (an
`emptyDir` copy of the checkout) to size what is left for node-local
checkouts to win (docs/nfs-checkout-performance.md "What stays slow").

Expected: the `add -A` walk and the two `ls-files` walks dominate, and the
diff body is small next to them. If the transport dominates instead, the
fix is in the stream relay, not here.

## 2. Cheaper walks

Try each against the numbers from step 1, and keep only what measurably
helps:

- **Untracked cache.** `git update-index --untracked-cache` on the private
  index, or `-c core.untrackedCache=true` in the script, lets git skip
  re-reading a directory whose mtime has not changed. The private index
  lives at a stable path, so the cache persists between polls. This
  depends on directory mtimes being reliable over NFS, so check that a file
  created on the server's side of the mount, or by another node, still
  shows up. It cannot help `--ignored`, which the untracked cache does not
  cover.
- **Parallel stats.** `core.preloadIndex` (on by default) splits the
  `lstat`s across threads, which hides round-trip latency well. Check with
  `GIT_TRACE_PERFORMANCE=1` that it actually runs in parallel under gVisor.
  Git only starts a thread per 500 index entries, so a small checkout
  gets no parallelism from it.
- **One walk for the full listing.** The two `ls-files --others` passes
  each walk the tree. One pass that prints untracked and ignored entries
  together (`git status --porcelain=v2 -z --ignored=matching
  --untracked-files=normal` against the private index), split by its
  status letter, would halve that cost.
- **A slower poll on a slow checkout.** If a run takes longer than the
  poll interval, the next poll queues as soon as the last ends, and the
  workspace is walked nonstop while the explorer is open. The server could
  report each run's duration and the client poll no faster than a few
  times that.

## 3. Opening the changes view

Opening the changes view still waits for the poll already running (which
did not ask for the diff body) before its own read starts. Two ways to
remove that wait, to be chosen once step 1 gives the body's cost:

- **Prefetch the body.** Ask for the diff body whenever the explorer is
  visible, not only in the changes view, so opening it shows what the last
  poll already has. Cheap if `git diff --cached` is small next to the walk,
  but it ships up to 1 MB per poll on a large changeset, so it could be
  limited to changesets under a size the server reports.
- **Cancel the abandoned read.** The client cancels its in-flight poll when
  the view changes, but the server keeps running it. The server could abort
  a read when every caller sharing it has disconnected, killing the
  in-workspace git and releasing the run lock, so the new read starts at
  once.
