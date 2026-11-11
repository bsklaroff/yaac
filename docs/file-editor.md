# File editor

The webapp browses, edits and reviews a workspace's files through four
kinds of pane, all ordinary layout leaves next to terminals:

- **`files`**: the explorer, one per workspace. A tree, a filter that doubles
  as quick-open, a "show ignored" toggle, git status colors, line counts
  against the diff base, create / rename / delete, and uploads.
- **`changes`**: the Changes pane, one per workspace: the workspace's review
  diff. It is the same component as the explorer (`WorkspaceFiles` with
  `changedOnly`), listing only the changed files, each with its diff.
- **`changes:<from>...<to>`**: the same pane on any range (see "Ranges"),
  as many as are open.
- **`commits`**: the Commits pane, one per workspace (`WorkspaceCommits`):
  the history of HEAD and of the branch the workspace is based on, as a
  graph beside a commit list. Its strip picks that branch.
- **`file:<path>`**: one editor pane per open file (`<path>` is relative to
  the workspace root). Side-by-side files, tabs, drag, Alt-W, tab cycling and
  persistence across reloads all come from the layout, so there is no second
  tab system inside a pane.

Columns stay equal-width, so the explorer takes a full column. In tabs mode
and on phones, the filter (quick-open) is the way to find a file.

## Server

### Plain `fs` on the server's filesystem

`#domain/workspaces` reads and writes the checkout with plain
`fs` on `workspaceDir(projectId, id)`. Under k8s the server pod mounts that path;
under containerless it is the host checkout. So there is no driver verb, and
both drivers behave the same.

A save that overwrites a file in a running k8s workspace then opens that
file inside the pod, after releasing the workspace's edit lock: one exec,
an open that reads nothing, bounded to a few seconds, logged if it fails. A pod mounts its checkout with file
attributes cached for up to a minute, so without the open its `git status`
(the changes view, the agent's own) could miss the edit for that long; an
open always revalidates (docs/nfs-checkout-performance.md). Creating,
renaming or deleting needs nothing, since the pod caches directories for a
second.

Every file route resolves the workspace's record (`resolveWorkspaceRecord`),
so a stopped workspace's files open and save like a running one's
(docs/workspace-storage.md). A path is relative to the workspace dir, so in
a workspace whose repos sit in folders (docs/project-repos.md) it starts
with the checkout's folder, and each checkout's `.git` is out of reach. The exceptions are the changes (which carry the
listing and the status bar's counts) and a file's text at the diff base,
which run git inside the workspace. For a stopped workspace they return
`CONFLICT`, shown as "Start the workspace to browse its files" (or "to
review its changes").

Ownership needs no handling: the server already runs as the workspace's user
(the install uid from `installSecurityContext()` on k8s, the host user under
macOS virtiofs, the same process user under containerless).

| Route | Answer |
|---|---|
| `GET /workspace/:id/dir?path=` | the immediate children of one folder (capped at 5,000) |
| `GET /workspace/:id/file?path=&known=` | `{ path, version, size, binary, content? }` |
| `GET /workspace/:id/raw?path=` | a media file's bytes (see "Media files"), honoring one `Range` |
| `PUT /workspace/:id/file` | `{ path, content, baseVersion }` → `{ path, version, size }`, or 409 |
| `PUT /workspace/:id/upload?path=&replace=` | streams the raw body into a file, making missing folders; 409 if taken, unless `replace=1` |
| `POST /workspace/:id/folder` | creates a folder and its missing parents; 409 if taken |
| `POST /workspace/:id/rename` | moves a file, folder or symlink; 409 if the destination exists |
| `DELETE /workspace/:id/file?path=` | deletes a file, a link (never its target) or a folder, recursively |
| `GET /workspace/:id/changes?repo=&base=&diff=&listing=&known=` | `WorkspaceChanges`: `{ base, work, baseResolved, files, diff, truncated, branch, comparison, listing?, readMs }`; `diff=0` leaves the `diff` field out, `listing=paths\|full` adds `WorkspaceFiles` unless its version is `known` |
| `POST /workspace/:id/changes/diff` `{ base, work, files, skip?, repo? }` | `{ diff }`: more of the reading `base` and `work` name — the parts of `files` (each `{ path, oldPath? }`, at most 200), or with `skip` one file's part after its first `skip` lines; 404 once either tree is gone |
| `GET /workspace/:id/compare?from=&to=&repo=` | `WorkspaceComparison`: `{ base, work, baseResolved, files, diff, truncated, commit? }`, the diff from the merge base of `from` and `to` to `to`, or with no `from`, `to` as `git show` shows it (see "Ranges"); 400 when a ref does not resolve or the two share no history |
| `GET /workspace/:id/file-at?path=&rev=` | `{ exists, content }`: the file at commit `rev` (a full object id) of the checkout its path is in, `content` null when binary or over 1 MiB |

The git reads (`changes`, `changes/diff`, `compare`, `commits`, and
`POST /workspace/:id/base`) are of one checkout. `repo` names it by its
path under the workspace dir or its repo's id; a workspace with one
checkout needs none, and one with several is refused without it. A diff's
paths are relative to its checkout. The listing covers the whole workspace
whichever checkout is named: each checkout's gitignore-aware listing under
its folder, and in a workspace whose root is no checkout, whatever else is
there, found by a plain walk. A workspace with no repos answers no changes
and no commits.

### Changes

The webapp polls one route per workspace, `changes`, for the diff, the
status bar's counts and the explorer's listing. The changes are everything
that differs from the **diff base**: the merge
base of HEAD with the checkout's base branch (`workspace_repos.baseBranch`,
as `origin/<base>`: every way of setting it checks origin has it, and a
local copy is never kept current), else, for a checkout created at a commit
with no base branch, that commit (`workspace_repos.startCommit`,
docs/workspace-steps.md). The base branch is the one the checkout forked
from until the Commits pane's picker or `yaac-mama set-base` moves it
(`setWorkspaceBase`). Each checkout has a private index and held state of
its own, so reads of two checkouts never wait on each other. A read is two scripts (`changes.ts` in
`#domain/workspaces`) run inside the workspace through the driver's `exec`,
under either driver. The first, the **scan**, runs `git add -A` into a
private index at a stable scratch path, so the
whole working tree is diffed without touching the agent's index, and git's
stat cache keeps each poll incremental. The objects it writes (each new
file's blob, and the trees of the agent's index and the working tree) go to
an object directory beside the private index (`GIT_OBJECT_DIRECTORY`), with
the checkout's own store read as an alternate, so polls leave nothing in
the checkout and a new file costs a write to pod-local scratch rather than
to the network filesystem: staging 1,000 new files took 2–4s, against
10–50s into the checkout's store on NFS. Scratch is held in the pod's
memory, so past 256 MB the directory starts over with the private index,
which is seeded again. So does a run that finds a blob missing: the agent
can add a file, reset it and prune, deleting a blob the private index still
names, which no stat check notices. `add -A` skips a tracked file that
matches `.gitignore` (one added with `add -f`), so those the agent's index
tracks are force-added after it, or they would read as deleted. They are
added by literal name (`--literal-pathspecs`): the names are the agent's,
and as pathspecs one named `:(glob)**` would pull in every ignored file,
credentials included. `add -A` runs with `--ignore-errors`, so an entry git
cannot index (a nested repo with no commit) is left out of the diff and the
listing instead of failing both. A missing private index starts as a copy
of the agent's, so a workspace's first poll reuses its stat data rather than
hashing every file, and `add -A` compares only mtime and size, since the
server writes a new checkout's index and a pod sees other inode numbers.

An untracked folder too large to stage is left out. Before staging, the
script lists the untracked files no ignore pattern covers (`ls-files -o
--exclude-standard` against a copy of the agent's index, which does not
walk into ignored folders) and counts them under every folder that holds
them. Taking folders deepest first, one holding more than 2,000, less what
folders already skipped below it hold, is **skipped**: `add -A` excludes it,
its entries in the private index go back to the agent's tree (dropping
anything an earlier poll staged there), and only its tracked files' edits
are staged. The answer names it in `skipped` as `dir/`; the Changes pane
shows it as one untracked row, "over 2,000 files, not diffed", and the
explorer as one folder whose children are read on expand, like an ignored
one. An untracked file over 10 MiB is left out the same way, since staging
it would copy it into pod memory, and named in `skipped` as itself; it is
added with intent to add, which records no object and puts it in no tree,
so the explorer still lists it. So a build
directory nobody ignored costs one more walk of the working tree per poll
instead of minutes of failed staging, while the agent's own `git status`
still sees every file, and the folder leaves the limit once it is ignored,
deleted or committed. At 2–4ms a file into the scratch objects, the
limit keeps staging a folder just under it within the 20-second warm
timeout.

Each run takes a lock file holding its pid, since a run whose exec timed
out or was abandoned can still be exiting when the next starts (both
drivers kill its process group, gently first): a later run waits for a live
holder and clears the lock of one that is gone or over two minutes old.
Staging fails when a file is deleted between `add -A` listing and adding
it, as a branch switch does to many, so it is retried with the index kept.
Both the wait and the retries stop 10 seconds after the run starts, the
wait answering `RUNTIME_UNAVAILABLE` (503). A failed `add -A` leaves the
private index as it was, so only one git cannot read is seeded afresh,
within the same run. A killed one also leaves the index as it was, since
git writes it only when `add -A` finishes, though the objects it wrote
stay. A cold index (missing, just
seeded, or behind a big branch switch) has `add -A` hash every changed
file, which took 20 to 45 seconds for 20,000 changes under gVisor, and is
slower on NFS (docs/nfs-checkout-performance.md), so a run cut off there
would leave the next to pay it again. The exec's timeout is therefore 20
seconds only after the workspace's last read succeeded, and 120 otherwise:
on its first read, after a server restart or five idle minutes, and after
a failed read (most often a timeout). An abandoned read leaves the next
one's timeout as it was, since being cut off by its caller says nothing
about the index. A checkout whose cold staging takes longer than 120
seconds never warms, and every read times out; `READ_TIMEOUT_MS` in
`changes.ts` is the limit to raise.

The script also reads which **stages** each file's changes sit
in: `committed` (base → HEAD), `staged` (HEAD → the
agent's index), `modified` (the agent's index → the working tree, git's
unstaged changes) and `untracked` (in the working tree, not the agent's
index). Each is a tree-to-tree diff, so the working tree is walked once, by
`add -A`, however many stages are read. The agent's index becomes a tree
from a scratch copy, so the real one is never written or locked; with a
merge conflict it has no tree, and its changes count as `modified`.
Each stage is its own diff, so their counts need not sum to the file's
totals.

Reading git objects is what a read costs on a large changeset over a
network filesystem; walking the working tree and reading trees are cheap.
So after staging, the scan prints only each pair's raw diff (`git diff
--raw --no-abbrev`, which reads trees alone): `committed`, `staged`, the
unstaged pair (the agent's tree → the working tree, without rename pairing)
and the base diff (base → the working tree). A file's numstat row and body
part are a function of its raw line (both modes, both blob ids, the status
with a rename's score, and the paths) and of the diff settings: `diff.*`
and `submodule.*` config, `core.bigFileThreshold`, `core.abbrev`,
`.gitmodules` and every attributes source, hashed together, since one
attribute can make another file binary. The `.gitattributes` files and
`.gitmodules` are hashed from the working tree's git tree, and the fill
reads attributes from that tree too (`GIT_ATTR_SOURCE`), so one staging
left out (in a skipped folder, or ignored) counts for neither; a git before
2.40 ignores the variable and reads the working tree's. The one input left
out on purpose is a textconv program's own output, taken to depend only on
the blob: a program edited without a change to its config shows its old
output for a file until that file's raw line changes. So the server keeps, per workspace, each pair's raw lines
under its two trees and the settings, and each file's counts and part
under the settings and its raw line (an **entry**), and the scan prints only
the pairs the server lacks: an idle poll prints none. The second script,
the **fill**, then reads what the entries lack, outside the run lock since
it reads only trees that never change: `git diff --raw --numstat` and the
capped body at those lines' paths (both paths of a rename, so git pairs it
again), or the whole pair past 300 lines. git pairs renames among the paths
it is given alone, so the fill's lines are checked against those it asked
for, and on a mismatch (a `diff.renameLimit` the whole pair passed, say)
the whole pair is read instead. The answer is assembled from what is held:
`files` are the base diff's lines in git's order, each stage is looked up
in its own pair, untracked files are the unstaged pair's added lines, and
the body is the parts in order up to the cap. So an edit costs a scan and a
fill of that one file however large the changeset, whatever kind of file it
is, and staging or committing it costs no fill at all, since the staged
line is the unstaged one it replaces and the committed one the base diff's.
A poll that wants no body fills only counts, and the next that wants one
fills the parts it lacks.

Nothing held belongs to a base. Raw diffs are kept for the four pairs of
each base's latest reading and the pair of each range (see "Ranges"), each
until five minutes after it was last read, and entries while a held raw
line names them,
so an agent rewriting one file leaves one entry for it, and a workspace
holds at most its bases' and ranges' changesets. All of it goes on
teardown. Entries are never shared between workspaces: each
is the output of a script the workspace's agent can shape.

The body rides in the poll, rather than every part loading through `POST
changes/diff`, since the Changes pane's find searches it. It is capped by
whole lines at 250 KB per file and 2 MB in all in the fill, and at 1 MB in
the answer; a file's part the cap cuts short ends in a
`DIFF_CUT_LINE` line, so one huge file cannot leave every file after it
with no diff. A part the fill's total cap cut is not kept, nor any after
it, all of which lie past the answer's cap. Each answer names its reading
by the base and the working tree's git tree (`work`), which `add -A` wrote
into the scratch objects, and `POST changes/diff` reads more of that
reading: the parts of files the cap left out, under the same caps, or a
page of up to 1 MB of one file's part past the lines the caller holds. A
page that starts on a line over 1 MB shows that line's first megabyte, cut
at a byte, and goes on from the next line. Both are the fill's body between
the two trees at those paths (a rename's old path too, so it pairs again),
so they match the poll's parts whatever the checkout has done since. A `git
diff` that fails before the body's cap (a textconv program that is missing)
keeps no part: the answer keeps its file list and shows the body as
truncated to nothing. A fill that finds a blob gone (the agent pruned one
the private index names) leaves a mark that has the next scan seed afresh;
a poll then runs once more, and `POST changes/diff` answers 404 as for a
gone tree.

The entries also live in the workspace's scratch, in
`yaac-changes.idx.entries` beside the private index, one JSON line each,
so a server restart costs a scan and the file read back rather than a fill
of every file. The server writes the file through the next scan's stdin,
appending the entries filled since the last scan, or replacing it with the
live entries once it would pass twice their size; the first scan after a
restart prints it back, unless it has grown past 32 MiB. A line cut short
by a killed write, or one that is not an entry, is dropped, and the file
replaced, so no append lands on the end of it. Kept in the
workspace, the agent's uncommitted content stays inside its sandbox, and
the file dies with the pod like the private index beside it.

Each answer says how long its read took (`readMs`), and the webapp waits at
least that long after an answer before polling again, but no more than 10
seconds. The read's costs are measured by `changes-bench.test.ts` beside
the changes tests, skipped unless `BENCH_REPO` names a checkout to read;
its header says how to build the fixtures it was tuned on. On a checkout of
this repo 683 changed files and a 5 MB body behind its base, under gVisor
on NFS, the base pair's raw diff takes about 0.4s from trees alone (0.75s
pairing renames), against 2–3s for its numstat and 4s for its body, and a
few files' blobs about 0.2s, most of it process start-up. Raw diffs are
read with `--no-abbrev`, since abbreviating each id probes the object store
through the alternates, which took 3s on the same pair. There an idle poll
took 1.2–1.5s, an edit to any file 2.4–2.8s, switching back to a base
already held 1.3s, and the first poll after an unignored 5,000-file build
directory appeared 2.3s. What stays costly: a poll after any change rescans
the base pair's trees and pairs renames among its unpaired added and
deleted files; raw lines cost about 145 bytes a file, so a changeset over
about 15,000 files pages its scan's output after every edit; the folder
count is one more walk of the working tree on every poll (about 0.8s on
30,000 files); and the first read after a server restart reads back every
pair's raw lines and an entry file of up to twice the live entries.

An exec's output is capped (streamd cuts one at 4 MiB, and `podExec`
rejects a cut one rather than pass it on), and a big checkout's first
read, with every file in its listing and every change's raw lines, can
pass that, and so can a fill of a whole large pair. So both scripts write
their output to a scratch file and print it only up to 2 MiB; past that
they print the file's name and size, and the server fetches it in base64
pages of that size, one exec each, refusing one over 128 MiB. The next
scan clears the file. Only the
last 4 KiB of stderr is passed on, since a warning per file could pass the
cap too.

The same run says how far HEAD is from the branch the base was found on
(`rev-list --left-right --count <ref>...HEAD`), so the status bar follows
the agent across a branch rename, and, when asked, lists the checkout:

- `root` is the driver's `workspaceDir`: where the workspace itself sees
  the checkout (`/workspace` in a pod, a host path otherwise), so a file
  link can read an absolute path the agent printed.
- `paths` is `ls-files -s` on the private index right after `add -A`: every
  file git does not ignore, deleted ones already gone, with no second walk.
  Git applies `.gitignore`, so there is no JS reimplementation. A symlink is
  an entry with mode `120000`; the server resolves where each leads to
  `{ target, dir }`, `target` relative to the workspace, or null when broken
  or outside it.
- `conflicted` is `ls-files --unmerged` on the copy of the agent's index.
- Only `listing=full` (the explorer, while mounted) walks the tree again:
  `ls-files --others --ignored --exclude-standard --directory` gives
  `ignored`, with a wholly ignored folder (`node_modules/`) as one entry, and
  `ls-files --others --exclude-standard --directory` gives the untracked
  folders. Git does not track folders, so those are walked on the server
  (through pinned descriptors, not following links, skipping ignored
  folders) to find ones with no listed file: `emptyDirs`, which keep a "New
  folder" visible on the next poll.
- The server then folds in the workspace's scratch dirs (docs/project-config.md
  "Scratch directories"): each one that holds no path of `paths` becomes one
  `dir/` entry of `ignored`, replacing whatever `ignored` and `emptyDirs` named
  in it. So the explorer hides the empty `target` every workspace is given
  even in a project that neither builds with cargo nor ignores it. One that
  holds a file git would list, or a changed one such as a tracked file a
  scratch volume hides, stays as it is, so nothing git cares about is hidden.

The listing's sections are NUL-separated, since a path can hold a newline,
and print before the completion marker, so a run that died partway cannot
look like an empty checkout. The server holds the last listing, so a poll
prints only the parts that moved. `paths` is printed again only when a path was added,
deleted or retyped since the working tree it was read at (`git diff-tree
--diff-filter=ADT`, which reads trees, not files), so an edit leaves it as
held; `ignored` and the untracked folders are walked every `full` poll but
printed only when their hash differs from the held one. It is capped at
50,000 paths (`truncated`). Its `version` hashes the whole listing as the
server finishes it; the client sends it back as `known`, and an unchanged
listing is left out of the answer.

A file's original for the editor's diff modes comes from `file-at`, which
runs `git cat-file` on `<base>:<path>` inside the workspace (the old path for
a rename). The commit is the `base` the changes answer named, so the text
never changes and the client caches it for good.

### Ranges

A Changes pane can show any range instead of the workspace's own changes.
Its target names it, `changes:<from>...<to>` (a ref name holds no `..`, so
the first `...` splits it), and each end is a branch on origin (by name,
tried as `origin/<name>` before itself), a commit, or `HEAD`, which is
always the checkout's own and never `origin/HEAD`. The newer end may also be
`:worktree`, the working tree, uncommitted work included; `:` cannot appear
in a ref name.

A range compares as GitHub compares branches: from the merge base of its
ends to the newer one, so it shows what `to` adds, and two commits on one
line of history diff exactly. With no `from` it is one commit, diffed
against its first parent (a merge shows what it brought in) or, for a root
commit, against the empty tree, and the answer carries the commit's message,
author and parents for the pane's header.

A range ending at the working tree is the `changes` read with `base` set to
`from`, polled as a query of its own. Nothing the server holds belongs to a
base, so beside the workspace's own readers it costs its own fills once,
and its polls after that cost what an idle one does; a file whose blobs are
the same under both bases shares one entry. Only the private index is one
per workspace, so reads against different bases take turns. Any other
range is `compare` (`readComparison`), which reads no working tree: both
ends are commits, so its script resolves them and prints the one raw diff
unless the server holds it, the fill reads what the entries lack, and the
answer is assembled the same way. So a range read before costs only its
script, and one that shares files with the workspace's own diff shares
their entries. Its body is capped as the poll's is, and its `base` and
`work` are the merge base and `to`'s commit, so `/changes/diff` pages the
rest unchanged. A range between two full commit ids never changes and is read
once; one naming a branch or HEAD is read again every 30 seconds while on
screen.

### Git status bar

`GitStatusBar`, above a workspace's panes, shows the reference branch and how
far HEAD is ahead of and behind it, which opens the Commits pane, then the
total changed lines (`+52 −3`), which open the Changes pane. Both come from the
changes answer (`branch`, `comparison`, `files`), polled every 10 seconds
while the workspace is on screen. The bar also asks for `listing=paths`, so
the explorer's tree and the terminal's and chat pane's file links are ready
before the explorer opens.

It never fetches, so `behind` is only as fresh as the checkout's `origin/*`
(which the server keeps within minutes of origin, docs/server-git.md). The
bar shows `fetchedAt`, the newest mtime among:

- `server-local/git-fetched/`, a record each successful server fetch writes
  (git empties `FETCH_HEAD` even when a fetch fails);
- the checkout's `FETCH_HEAD`, for a fetch the agent ran;
- the branch reflogs in the main clone and the checkout, for a fetch that
  moved the branch.

### Commits

`GET /workspace/:id/commits` runs `git log --date-order` inside the workspace
over HEAD and the diff base's ref (`checkoutLog`), so the newest `limit`
commits (200 by default, `MAX_LOG_COMMITS` = 2,000 at most) come back
children before parents, each with its parents, author, time, subject,
body and decorations, plus HEAD's commit and whether older ones were left
out. Bodies are cut inside the workspace to 1 KB each and 512 KB in all,
a cut one ending in `…` (past the total, a body is `…` alone), so even
2,000 commits of bot release notes stay far under the 4 MiB exec output
cap and the 10-second poll stays small; a commit's own pane shows its whole
message. A body line loses any of the log's separator bytes, so a message
can neither add a row nor split a field. The
ref is checked by `RESOLVE_BASE_SH`, the same shell the changes script
runs, and kept only if it shares history with HEAD, so the pane, the
Changes pane and the git status bar always name the same ref.

The client lays out the graph itself (`layoutGraph` in `#lib/commits`). Each
lane waits for one commit; a commit takes the lane waiting for it, its first
parent continues that lane and a merge's other parents join or open one, so a
branch keeps one column and color from tip to fork point and lanes never
shift sideways. A layout depends only on the commits before a row, so "load
older" leaves the rows already shown in place. Each commit's line is a fixed
height and draws its half-row edges as SVG paths; a commit whose message is
unfolded grows below its line, where the lanes leaving it run straight on to
the next row. Commits not reachable from HEAD's
commit (those it is behind by) are dimmed. "Load older" stops at the cap,
which the pane then names. Of each commit's decorations only HEAD (labelled
plainly `HEAD`, not by its generated `agent/<id>` branch), tags and the
base branch get a pill, so a checkout with many branches leaves the
subjects room.

A commit with a body has a chevron that unfolds its message under its row,
and the strip has a button that unfolds or folds them all (the unfolded
commits are kept in the pane's `paneView`). Clicking a commit opens it in a
Changes pane as `git show` shows it (`changes:...<sha>`, see "Ranges").
Ticking two commits, or Cmd/Ctrl-clicking them, offers their range in the
strip, older to newer; a third replaces the first ticked. A commit's context
menu also compares it with the working tree or HEAD, and copies its id.

The pane's strip picks the workspace's base branch from origin's branches
(the project's branch list, refreshed while the picker is open). A pick is
confirmed in a dialog, since it moves the diff base of every pane and the
git status bar, and what is queued under the workspace forks from it; the
commits themselves stay where they are. `POST /workspace/:id/base` then
records it (`setWorkspaceBase`, which `yaac-mama set-base` runs too):
a branch the main clone lacks is fetched for, at most once per 10 seconds,
and a running workspace's `origin/*` is refreshed before the answer, so its
next poll finds the branch. A base the log cannot use keeps the strip up
over the error, so another can be picked from there. The pane polls every
10 seconds while on screen, as the bar does, and unmounts off it as the
explorer does.

### Confinement

Under k8s the sandboxed agent controls the checkout, and the server pod can
also see `server-local/`, so every path is a security boundary. All access
goes through the checkout opened as a confined root (`#lib/confined-fs`,
policy `inside`, `.git` excluded), the same helper used for tool homes and
conversation records. Symlinks are followed only if the final target is
inside the workspace (its `.git` counts as outside). The check runs on what
was actually opened, not on a path string:

1. **Lexical check.** Non-empty, relative, no NUL, no `..` after
   normalizing, not under `.git` (writing there is how a hook gets planted).
2. **Verify the descriptor.** After opening, `readlink('/proc/self/fd/<fd>')`
   must be at or under `realpath(workspaceDir)`, or the request fails with
   400 "points outside the workspace". All I/O then uses that descriptor, so
   no second lookup can be raced. Opens are non-blocking, so a planted FIFO
   cannot hang one.
3. **Pin each directory.** Create, mkdir, rename and delete open the parent
   path one segment at a time, each through the previous segment's verified
   descriptor (`/proc/self/fd/<fd>/<name>`, Linux's stand-in for `openat`),
   and act on the final name inside it.
4. **Without `/proc/self/fd`** (a macOS containerless server), the same
   checks use `fs.realpath`. There is no sandbox there, so a race gains the
   agent nothing. The branch is on whether `/proc` exists, not the driver.

A recursive delete opens each child folder through its parent's descriptor
and checks it landed exactly there; anything else is unlinked by name.
`O_NOFOLLOW` alone is not enough, because gVisor follows a link when
`O_DIRECTORY` is also set. Node's `fs.rm({ recursive })` walks by path, so a
folder swapped for a link mid-walk could lead it out of the checkout.

An absolute symlink resolves as the server sees it, so a link written in a
pod as `/workspace/x` looks broken. Rewriting targets would mean resolving
links by hand, which reopens the race the descriptor check closes.

### Reads, writes and versions

A file's **version** is the sha256 of its bytes. A read refuses anything that
is not a regular file. It returns `content: null` for a binary file (a NUL in
the first 8,000 bytes, or invalid UTF-8, the rule in `#lib/text-file`) or one
over 1 MiB, and omits `content` when the caller's `known` version is current.

A save names the version it was based on. Under a per-workspace mutex, the
server re-hashes the file through the descriptor it will write, and on a
mismatch returns 409 `{ version }` (the one error body with more than a code,
because the editor's next save uses it). Otherwise it truncates and writes
through that descriptor. So the file keeps its mode, inode, links and owner,
no inode is swapped under a gVisor pod's cached dentry, and saving through a
symlink updates its target.

### Media files

`@yaac/shared/media-types` maps extensions to the image, video, audio and
PDF types a browser renders itself. The `raw` route streams such a file
through the same confined descriptor, under that type with `nosniff`, and
refuses every other file. So the route never serves HTML or SVG, which
would run script on the app's origin; an SVG opens as text. As a second
check, the response carries `Content-Security-Policy: default-src 'none';
sandbox; frame-ancestors 'self'`: a response rendered as a document (opened
in a tab, or the PDF's iframe) gets an opaque origin and no script, so it
cannot reach the API. It does not apply to the `<img>`, `<video>` and
`<audio>` loads, which are subresources, and Chromium's PDF viewer still
renders under it. Sandboxing the iframe itself instead would break the
viewer. It honors one
byte range (anything else gets the whole file), which a `<video>` needs to
seek, and Safari needs to play at all.

A save never creates a file: a non-null `baseVersion` for a missing file is a
409 with `version: null`, which stops autosave from bringing back a deleted
file. Only `baseVersion: null` creates, with `O_CREAT | O_EXCL | O_NOFOLLOW`
in the pinned parent (making missing folders), never through a link.

### Uploads

`upload` writes the request body to disk as it arrives, so a file of any
size costs the server no memory (the server sets no request timeout, for
long uploads). A new file is created the way a save creates one, with
`O_CREAT | O_EXCL | O_NOFOLLOW` in the pinned parent, and removed if the
upload fails partway; anything already there is a 409. With `replace=1` the
body is staged first, in a file beside the target that is unlinked as soon
as it is made, so the agent can never reach it and a crash leaves nothing
behind. A dropped upload therefore leaves the original untouched. Once the
body is complete, the server opens the target through the confined root
(or creates it), truncates it only after the descriptor is verified, and
copies the staged bytes in place under the edit mutex, so two replaces of
one file never interleave. The file keeps its mode and inode, and the pod
opens it afterwards as after a save. A new file's upload skips the mutex,
so a long one never holds up a save.

Create, rename, delete and upload do not touch git. Their effect shows in the colors
and the changes, as `mv` or `rm` in a terminal would.

## Webapp

`#lib/files` holds the pane targets, the API client and pure helpers:
`buildTree`, `filterPaths`
(case-insensitive subsequence, best first, max 200), `fileTabLabels` (a
basename plus enough parent path to tell two `index.ts` apart) and
`placeFile`. `placeFile` follows VS Code's "open in the active editor group":
a tab in the column holding the active file pane, else in any column with a
file pane, else a new column right of the explorer or the Changes pane (the
active one first), else at the end.
`renameTargets` in `#lib/layout` updates every `file:` target under a renamed
path.

### Explorer and Changes pane (`WorkspaceFiles`)

Both unmount when off-screen. Each keeps its own view state (expanded or
collapsed folders, scroll, filter, its toggles) in the store's `paneView`.

The changes and the listing come from `useWorkspaceChanges`, one query
shared by the explorer, the Changes pane, the status bar and every file
pane, so a workspace polls once however many show them. Each reader sets its
own poll: 3 seconds while the explorer, the Changes pane or a visible file
pane shows them, 10 seconds for the status bar alone. A hidden file pane
never fetches; it reads what the others fetched. The costly parts go only
while some reader wants them: the diff body, up to 1 MB, for the Changes
pane, and the full listing's walks for the explorer (the Changes pane needs
only `paths`, for conflicts). What a fetch asks for is read when it runs
rather than kept in the query key, so readers mounting together share one
fetch and a reader leaving never forks the query. The listing lands in its
own cache entry (`useWorkspaceFiles`), so the tree, the line counts and the
colors always come from one snapshot. An answer without a diff body is one
that did not ask for it, so the Changes pane shows its diffs as loading
until its own fetch lands. On the server, `runChangesRead` runs one read
of a checkout at a time, since each walks the whole working tree: a
request merges into the read queued behind the running one, never into
the running one, which could predate an edit the caller just made. A fetch
the webapp replaces is aborted, and a read every request has left is
dropped from the queue or stopped mid-run (its process group killed), so
opening the Changes pane during a status-bar poll waits only for its own
read. A failed poll leaves the last answer cached, so the status bar shows
the error in its place and both panes mark their tree "Not up to date".

- **Tree.** Only rows under expanded folders render, so a large repo needs no
  virtualization. Files get an icon and tint from `languageForPath`. A
  changed file's name is colored by how it differs from the diff base
  (added, modified, renamed, …; a conflict outranks that), and beside it
  are its total `+N −N` and a letter per stage its changes sit in: `C`
  committed, `S` staged, `M` modified (unstaged), `U` untracked, after a `!` for a
  merge conflict. A folder shows a dot in the strongest color among its
  files (`pathStatuses` in `#lib/gitStatus`).
- **Changes pane** (its header button, the status bar's line counts, or
  `open-changes`) lists only the changed files, including deleted ones
  (struck through, not openable), each with its read-only diff under its
  row, its long lines wrapped to the pane's width. Opening it clears its
  filter, so its totals are every change, as the status bar's are; its
  layout and folds stay as last left. It starts as a flat list of full paths
  with every diff folded; a toggle switches to a tree, whose folders start
  open (so it records the closed ones). A diff mounts in 200-line chunks
  only as they come within a screen of view, so a change of hundreds of
  files opens at once. Out of view, a chunk holds the height it measured
  when last on screen, or, once its lines or the pane's width have changed
  since, an estimate of their wrapped height at the current width. Clicking
  a file's row opens or folds its diff (remembered per file across both
  layouts), and only its name opens it. A header button collapses every diff
  while any is open, and shows them all once none is. A strip shows the diff
  base, the shown files' totals overall and per stage,
  and what the diff leaves out (only uncommitted work when no fork point
  resolves, a body cut at 1 MB). Its "Compare…" opens a range pane from the
  base to the working tree. A range pane's strip has a picker per end
  (origin's branches, HEAD, a typed commit id, the working tree for the
  newer end, and for the older end of a range ending at a commit, "Parent",
  which goes back to that one commit); a pick retargets that pane in place, or focuses the pane
  already showing the new range. "Review diff" leads back to the
  workspace's own. A single commit's pane is headed by its message, author
  and parents, each parent opening its own pane. Past the cap the pane loads the rest as
  it scrolls (`useChangeDiffs`): a file the body left out loads its part
  once its diff comes within a screen of view, batched with the others in
  view, and the end of a cut part loads the next page of it, so every diff
  can be read to its end by scrolling, any line over 1 MB shown cut. A
  loaded part outlives its reading while later polls show the same header
  for the file (its `index` line names both blobs), so an agent editing
  other files does not throw away what was scrolled through. One the poll
  left out is shown until a reader near it loads it again, and is dropped
  if that fails, so the file says its diff did not load. Loaded parts go
  once the poll's body is whole or the file is no longer changed. A chunk whose lines did not
  change keeps its measured height as pages land below it. The filter
  matches paths (a rename's old
  one too) the way quick-open does, keeping the list's order.
- **Find in diffs** (Cmd/Ctrl-F in the Changes pane, or its header's search
  button) uses the find bar's controls (`FindControls` in `ui/FindPanel`),
  as the editor's and the conversation's do, with no replace row, over the
  diff lines of every file the filter shows, in the order shown
  (`useDiffFind`). Hunk headers are left out. The lines are joined into one
  document so the same worker (`MatchCounter`) counts them, with no cap,
  since stepping walks the counted matches and the 1 MB body bounds them.
  Each match maps back to a file and line, highlighted in `DiffView` in the
  editor's match colors. Typing lands on the first match; Enter and
  Shift+Enter step, unfolding the diff and folders the match is in, forcing
  its chunk to mount, and scrolling to it. A step re-renders only the diffs
  of the old and new current match. Escape closes the bar and clears the
  marks; the query stays for the next Cmd/Ctrl-F while the pane is mounted
  (it is component state, so leaving the tab drops it).
- **Text size** is `filesFontSize` (default 12px, saved in localStorage),
  one value for the explorer and the Changes pane, separate from the
  editor's. It scales the list under the header through CSS `zoom`, so
  icons, indents and diffs grow with the text and a diff chunk's height
  estimate holds in the list's own pixels. Set it with Cmd/Ctrl =/−/0 in the
  pane, the header's "Aa" popover, or a two-finger pinch over the list
  (`usePinchSize`). Only the list is `touch-action: pan-x pan-y`, so one
  finger still scrolls it natively and a pinch there resizes the text,
  while a pinch over the header, which does not scale, zooms the page. On
  phones the rename input's text is at least 16px through the `zoom`, since
  iOS counts `zoom` toward the size it zooms the page on focus below.
- **Collapse / expand all folders** in the explorer collapses every folder
  while any is open, and expands them all once none is, except the folders
  listed on demand (ignored ones and folder links).
- **Quick-open** replaces the tree while the filter has text: basename first,
  folder after, arrow keys to move, Enter to open.
- **Links** show a glyph. Broken or escaping ones are dimmed and do not open.
  A folder link expands by listing its target under the link's name
  (`lib → src/lib` shows `src/lib/*` as `lib/*`), lazily, so a link to an
  ancestor does not loop. The server follows the link when a file under it
  opens. The filter searches real paths only.
- **Ignored files**, scratch dirs among them, come with every listing, so the
  toggle refetches nothing.
  A wholly ignored folder's children come from the `dir` route on first
  expand. The filter searches ignored files but not inside ignored folders.
- **Create / rename / delete** use an inline input (a `/` in the name creates
  folders), opened from the header or a row's menu (right-click, or the hover
  `⋯` on touch). A rename first saves every affected pane, since each
  remounts under its new path, and is refused with "Resolve unsaved changes
  first." if that fails. A delete cancels affected autosaves, confirms
  (counting a folder's files, noting a link goes without its target, listing
  unsaved panes), then closes those panes.
- **Upload** files or a folder from the header (into the selected folder,
  as New file does) or a folder's menu, or drop them on the explorer, which
  tints the folder under the pointer: a file's row stands for its folder,
  empty space for the root. A dropped folder is walked through
  `webkitGetAsEntry`, keeping its empty folders, which the folder picker
  cannot report. `#lib/upload` sends each file as its own request, four at
  a time, under a progress line. Files already there are offered together
  in one "Replace?" confirmation once the rest are done; other failures,
  including dropped entries the browser cannot read (a broken link), show
  above the tree without stopping the rest.

### Editor pane (`WorkspaceFile`)

The editor is CodeMirror via `ui/CodeEditor`. Its language comes from
`#lib/highlight` (`languageForPath` → `editorLanguage`), which the diff view
also uses, and its theme uses the app's CSS variables and the same `tok-*`
colors as the diff. The pane stays mounted while hidden, like a terminal, so
undo history, cursor and unsaved text survive.

`openFile` takes an optional line, from a file link in a terminal or the
chat pane. The store holds it as `revealLine` until that file's editor has
its text, which then puts the cursor at the line's start, scrolls it to the
middle, and clears it; a line past the end lands on the last, and an
`openFile` without a line clears a pending one. The editor takes focus only
if what had it at the click still does: a file that loads late must not
take keystrokes the user has since started typing somewhere else.

- **Text size** is one store value, `editorFontSize` (default 12px, saved in
  localStorage), shared by file panes and settings editors. Change it with
  Cmd/Ctrl =/−/0 in the pane (matched on the character, so it works on any
  keyboard layout, and sizes the text instead of zooming the page), the
  header's "Aa" popover, or a two-finger pinch over the editor, as in the
  explorer; a pinch over the header or a media preview zooms the page. On
  phones, index.css pins editor text at 16px to stop iOS focus-zoom, so the
  file pane draws its editor at 16px and scales it to the chosen size with a
  `transform`. iOS judges focus-zoom by font size, which a transform leaves
  alone and CSS `zoom` would not. The find bar mounts above the editor
  (CodeMirror's `panels({ topContainer })`), outside that scale, so its
  controls keep their size. The settings editors stay at 16px there.
- **Changes.** The header shows the file's `+N −N` against the diff base and
  the stages its changes sit in. A diff mode (`fileDiffMode`, one saved
  store value for every file pane) shows them in the editor, through
  `@codemirror/merge`'s unified view (`#lib/diffEditor`): `plain`, `added`
  (changed lines tinted, still editable), `inline` (removed lines too, as
  read-only widgets between them) or `changes` (unchanged stretches folded
  away). The diff is against the file at the base and follows edits live.
  A file with no change, or a binary or oversized original, shows plain.
- **Find** is `ui/FindPanel`, CodeMirror's search panel redrawn in React: a
  query field with a live "3 of 12" count, case / whole-word / regex toggles,
  previous / next, and a replace row behind a chevron. Enter and Shift+Enter
  step. Escape returns to the editor without reaching `document`, so a dialog
  around a settings editor stays open. Every `CodeEditor` has it.
- **Match counting runs in a Worker** (`MatchCounter`, `#lib/matchCount`),
  because a backtracking regex can run forever and `RegExp.exec` cannot be
  interrupted. It is debounced, and the worker is terminated when superseded
  or after 1.5 s. A regex reaches CodeMirror's search state (whose highlighter
  and next / previous run on the main thread) only after the worker counted
  it in time; one that did not shows "Too slow to count".
- **Polling** runs only while visible: every 2 seconds and once on becoming
  visible, sending `known`. A clean buffer applies a new version as one
  minimal change, so the cursor stays put. A dirty buffer keeps the user's
  text under a "Changed on disk since you started editing: Reload ·
  Overwrite" banner.
- **Saving** happens 1 second after the last edit, and immediately on
  Cmd/Ctrl-S, the Save button, the pane hiding or losing focus, or the start
  of a close or rename. One save runs at a time; edits made meanwhile are
  saved next against the version it returned, so the pane never conflicts
  with itself, and a poll sent before a save landed is ignored. Network
  failures retry after 2, 5, then 10 seconds.
- **Media.** A file whose extension is a media type shows as an `<img>`,
  `<video>`, `<audio>` or, for a PDF, an `<iframe>` holding the browser's
  viewer (the desktop app enables Chromium's PDF plugin for it), whatever
  its bytes. The URL carries the file's version, and the pane keeps
  polling, so an image the agent regenerates reloads. A file the browser
  cannot decode says so.
- **A 409 pauses autosave** until Reload or Overwrite. A deleted file shows
  "Deleted on disk" with Close, plus "Save to recreate" if the buffer is
  dirty; that is the only way a deleted file comes back.
- **Closing** (tab × or Alt-W) saves first and closes once the save lands;
  only a save that cannot land asks before discarding. A dirty tab shows a
  dot, and `beforeunload` warns while any file is dirty.

### Previews

A markdown (`.md`, `.markdown`) or HTML (`.htm`, `.html`) file can be shown
rendered instead of as text, read-only, from a toggle in its header. The
choice is one saved store value (`filePreview`) for every file pane, like
the diff mode. The preview draws the editor's current text, unsaved edits
included, and the editor stays mounted underneath, hidden, so switching back
keeps its undo history. While previewing, the header's find and diff
controls are hidden, since they act on the editor.

**Markdown** renders in the pane (`MarkdownDocument`) with the chat pane's
GFM, code blocks and inline code, styled as a document by the Tailwind
typography plugin in the theme's colors, at the editor's text size. Raw
HTML stays off, as in chat. Links and images resolve from the file's
folder (`linkedCheckoutPath`; a leading `/` is the checkout root, as on
GitHub). A link to a checkout file opens it, and a heading or footnote
link (`#…`) scrolls to its target, whose id carries GitHub's
`user-content-` prefix so it cannot clobber one of the app's. A checkout
image is read through the file routes and shown as a `data:` URL, within
an `InlineBudget`: 5 MB a file and 32 MB for the whole document, judged
from the raw route's `Content-Length` before the body is read, so neither a
huge image nor many images (or one under many symlinked names) can exhaust
the tab. One that does not fit shows as its alt text. An image elsewhere
stays a link, for the reason chat's do: fetching it could leak data
encoded in its URL.

**HTML** renders as a static page that runs no script and loads nothing
from anywhere (`HtmlDocument`). Before it is shown, its own stylesheets
(`<link rel=stylesheet>` to a checkout file) are inlined as `<style>`, with
`</style` escaped so the text stays whole, and its checkout images as
`data:` URLs. Each path is read once, within one budget as in markdown, and
each further use of a path is charged again, since every copy is written
into the page; one that does not fit stays unloaded. At most 100 are
inlined: stylesheets first, then images, each in document order. The page is then parsed again, as the iframe will parse
it, because inlined text can parse as markup where it lands (a stylesheet
linked inside `<svg>`), and the rest works on that tree. Scripts, `<base>`
and every `http-equiv` meta are dropped, and a policy meta at the top of
its head (`default-src 'none'`, inline styles and `data:` images and fonts
only) refuses every other load: a CDN stylesheet, a remote image, a frame,
or one that inlined text added. The
result is the `srcdoc` of an iframe sandboxed with only `allow-popups` and
`allow-popups-to-escape-sandbox`. So it has an opaque origin, which the
server's Origin and Sec-Fetch-Site guards refuse, and no script, forms or
top navigation. A heading link is rewritten to `about:srcdoc#…`, which
scrolls within the frame (a bare `#…` would resolve against the app's URL
and navigate the frame away). A link (`<a>` or `<area>`) elsewhere opens a
new tab with `rel="noreferrer noopener"`, whatever its own `rel`, and a link
to another checkout file is left inert, since the parent cannot see a click
inside an opaque frame. A page that builds itself with script shows only its
static markup, `<noscript>` included. Relative URLs inside a stylesheet
(`url()`, `@import`) are not followed.

### Keys

- **`open-files` (Alt-E)** is a shortcut-registry command. It opens or
  focuses the explorer and sets `findPending` to it, so the explorer focuses
  its filter: Alt-E, a few letters, Enter is quick-open. (Option-E is a dead
  key on macOS, like every Alt-letter default.)
- **Cmd/Ctrl-S, Cmd/Ctrl-F and Cmd/Ctrl =/−/0 are fixed**, not in the
  registry. Cmd/Ctrl-S is handled on the file pane's root, so it works from
  the header strip, never reaches a terminal (Ctrl-S stays the shell's there),
  and keeps its browser meaning elsewhere. Cmd/Ctrl-F opens the file pane's
  find bar or the Changes pane's, or jumps to the explorer's filter; in a
  conversation pane it searches the conversation (docs/agent-modes.md,
  "Find").
- **`open-changes` (Alt-G)** opens or focuses the Changes pane and focuses
  its filter, the same way. Because the workspace's
  shortcut listener runs first (capture phase), `validateChord` refuses these
  chords and `mergeBindings` drops a stored override that uses one.

Out of scope: preview tabs, per-column widths, LSP, collaborative cursors, and
search across files (the terminal has `rg`).
