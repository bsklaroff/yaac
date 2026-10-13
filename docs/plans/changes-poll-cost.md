# The changes poll on a large changeset

The webapp polls `/changes` every 3 seconds while the explorer, the Changes
pane or a file is visible, and every 10 seconds for the status bar
(docs/file-editor.md). Each poll runs the changes script
(`#domain/workspaces` `changes.ts`) in the workspace, under a 20s
exec deadline. On a workspace whose branch has diverged a long way from its
base, a run costs more than the deadline and every poll fails, so the status
bar shows "Git status unavailable: stream read timeout". This plan caches
what the script derives from git objects, then makes the cache incremental
so that one edited file costs one file's diff.

## What a poll costs

Measured on `infra/hetzner-k3s` (yaac-15), cx53 nodes, against the poll's
warm private index, on two workspaces of the yaac repo: one with 3 files
changed against its base, one with 558 (+9.8k/-12.7k lines, a 2.1 MB body).

| Step | 3 files, NFS | 558 files, NFS | 558 files, node-local copy |
|---|---|---|---|
| `add -A` | 0.14-0.31s | 0.16-1.34s | 0.07-0.22s |
| `ls-files --others --ignored` | 0.09-0.16s | 0.08-0.53s | 0.05-0.07s |
| `ls-files --others` | 0.07-0.11s | 0.07-0.61s | 0.04-0.06s |
| `diff --raw` base -> work tree | 0.07s | 3.5-5.0s | 0.08-0.14s |
| `diff --cached --numstat` | 0.07-0.12s | 1.5-4.7s | 0.63-0.80s |
| `diff --cached` (body) | 0.08-0.15s | 3.8-11.9s | 0.74-0.87s |
| whole script, `nodiff` | | 4.7-5.1s | |
| whole script, with body | | 14s | |
| whole request (`curl`) | 1.1-1.8s | 17-31s, or a 500 at 20s | |

Each range spans back-to-back runs and runs after 5s and 65s idle; the high
ends are the idle ones and a node at 70% CPU.

- **The walks are cheap.** Under 0.3s warm on both workspaces, and at most
  1.3s after a minute idle. The NFS mount options and the gVisor dentry
  cache (docs/nfs-checkout-performance.md) already hold them down.
- **Object reads are not.** Every step that reads trees or blobs grows with
  the changeset and runs 5-40x slower than on node disk. A single-path
  `git diff <base> <work> -- <path>` costs 0.09s, so the cost is the
  number of objects read, not git's fixed overhead.
- **gVisor's file proxy is most of the gap.** The same reads from a runc
  pod on the same node, through the kernel NFS client, take 0.42s for the
  tree diff (gVisor: 2.3-2.9s), 1.5s for numstat (1.7-1.9s) and 1.7s for the
  body (3.9-4.5s). Single object reads (`cat-file --batch`) differ much less
  than that between gVisor-on-NFS and node disk, which leaves pack access
  patterns (delta chains, mmap faults through the proxy) as the likely
  source; the measurements do not separate them further.
- **Timed-out runs stack.** On timeout the server closes the stream and
  streamd kills the `sh` it spawned, but not that shell's children, so the
  script keeps running and holds its run lock. The next poll waits up to
  10s for that lock, then pays its own 14s, misses the deadline too, and
  leaves its own orphan. That is why the whole request takes 17-31s when
  the script alone takes 5-14s.

## 1. Kill a timed-out run

streamd runs each `exec` in its own process group (`detached: true`) and
kills the group (`process.kill(-pid, ...)`) when the stream closes, so a
timed-out run releases the private index and the run lock at once. The
script's `EXIT` trap still removes the lock file on `SIGTERM`. This alone
turns a failing workspace into one that answers late instead of never, and
it subsumes "cancel the abandoned read": the server already closes the
stream when its caller gives up.

Test in `dockerfiles/streamd/test/streamd.test.ts`: an exec of
`sh -c 'sleep 30 & wait'` whose stream is closed leaves no `sleep` behind.

## 2. Cache by tree pair

Everything after `add -A` is a pure function of four object names: `base`,
`head`, `agent` (the agent's index written as a tree) and `work` (the
private index written as a tree). The script already computes all four
before its first expensive command. Cache the derived sections under that
key, the way `committed` is cached under `$base $head`:

- Diff `"$base" "$work"` rather than `--cached "$base"`. They are the same
  diff, since `work` is the private index's tree, but the tree form names
  every input in the key.
- Keep two cache files beside `${indexFile}.committed`: `.lists` (the
  staged, modified, untracked, numstat and name-status sections) keyed on
  `$base $head $agent $work`, and `.body` (the body, already cut at
  `WORKSPACE_DIFF_CAP_BYTES`) keyed on `$base $work`. A `nodiff` run fills
  only `.lists`, so the status bar's poll never pays for a body nobody shows.
- Write each through `.tmp` and `mv`, as `.committed` is, so a killed run
  never leaves a half-written entry; a key line that does not match is a
  miss.

A poll where nothing changed then costs `add -A`, three `write-tree`s
(~0.5s on the 558-file workspace) and two `cat`s. While the agent edits, the
key changes on almost every poll, which step 3 addresses.

Tests in `packages/server/test/domain/workspaces/changes.test.ts`,
which runs the script against real repositories: a second run with nothing
changed prints byte-identical output; editing, staging, committing or
switching base each invalidates the right entries; a run killed mid-write
leaves the next run correct.

## 3. One edited file costs one file

When `work` changes but `base` and `head` do not, the new reading differs
from the cached one only at the paths that differ between the old and new
work trees. `git diff --raw --no-renames <old work> <new work>` finds those
paths by reading only the trees along the edited paths, so it stays cheap
however large the base diff is. The script then recomputes just those paths
against the base, `git diff <base> <work> -- <paths>` (and the `--numstat`
and `--name-status` forms), and splices them into the cache.

The splice belongs in TypeScript, not in the script: the parser already
splits the reading into per-file entries, and per-file body chunks are a
split on `diff --git` headers. So the cached reading lives in the server,
in `runChangesRead`'s module, keyed by workspace:

- The server sends the key it holds (`base head agent work`) as a fifth
  argument. The script prints `UNCHANGED` when the key matches, or
  `DELTA <paths>` sections for the changed paths, or a full reading
  otherwise.
- Fall back to a full reading when `base` or `head` moved, when the
  old->new work diff has more than a few hundred entries, or when a changed
  path is added, deleted or part of a rename in either reading. Rename
  pairing needs both sides in one diff, and those cases are rare between two
  polls.
- `agent` changes (a `git add`) move files between `staged` and `modified`
  without changing the base diff. Recompute the two stage sections in full
  (they span only uncommitted work) and keep the cached base sections.
- A body cut at the cap stays a prefix of per-file chunks. After a splice,
  re-cut the chunks at the cap; if the cached chunks end before the cap
  because later files were never fetched, the body is still `truncated`.
- Evict a workspace's entry when no poll has read it for five minutes, and
  on teardown. A full entry is at most the 2 MB body plus its lists.

This keeps the in-pod files from step 2 as the cache for a server restart
and for the first poll after one. Tests extend the same file: an edit to one
file of a large fixture repository yields the same reading as a full run,
and each fallback condition takes the full path.

## 4. A slower poll on a slow checkout

As a backstop when a full reading is still slow (the first poll, a base
change), the server reports each run's duration with the answer and the
client polls no faster than three times it.

## Not pursued

- **Untracked cache, `preloadIndex`, one `status` walk.** None measurably
  helps: the walks are already 0.1-0.3s, the untracked cache and
  `preloadIndex=false` land inside the noise, and one `git status
  --ignored=matching` walk costs more (0.7-2.2s) than the two `ls-files`
  walks it would replace (0.3-0.5s).
- **Reading the checkout from the server (isomorphic-git).** The server
  never runs git against a checkout's git dir, which the agent writes
  (docs/server-git.md); the one server-side read, `yaac-mama fetch`, copies
  a link-free snapshot into a sandboxed child. The changes read also needs
  the working tree, which a snapshot cannot copy every 3 seconds, and
  isomorphic-git has no stat cache (it hashes files to find edits) and no
  patch output. It would also move every workspace's diff CPU into the one
  server process. The kernel NFS client the server would read through is
  2-6x faster than gVisor's proxy for these reads, but steps 2 and 3 skip
  the reads altogether.
- **A node-local checkout.** It would make every object read node-disk
  fast, and is weighed in docs/nfs-checkout-performance.md "What stays
  slow"; it does not change how many objects a poll reads.
