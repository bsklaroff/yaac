# The changes read: one cache keyed by content

The changes read (`changes.ts` in `#domain/workspaces`, docs/file-editor.md
"Changes") caches its work in three layers: five section files beside the
private index, each holding one answer keyed by the trees it was read from;
the server's held reading, which the script patches through the `MODES`
same/delta/full protocol; and the held listing with its `EXTRAS` hash. Each
layer has one slot per workspace, so a Changes pane on a range ending at
the working tree (docs/file-editor.md "Ranges"), which polls its own base
beside the workspace's, evicts the default on every alternate poll. This
plan replaces the first two layers with one cache, keyed by what each
file's diff is a function of. It handles any number of bases, covers edits
the delta misses, and survives a server restart, in slightly less code.
Two smaller changes stop a large untracked folder, such as a build
directory nobody ignored, from stalling the read: staging writes its
objects to pod-local scratch, and a folder over a size limit is not staged
at all.

## What a read costs, and what each layer buys

Measured in a yaac dev workspace under k8s: gVisor (directfs, the 200,000
dentry cache) with the checkout on the cluster's NFS share, the setup
docs/nfs-checkout-performance.md describes, on git 2.53 and 8 cores. The
node is shared, so treat differences under about 30% as noise. Two
fixtures:

- **yaac**: a shared clone of this repo with `main` 40 commits behind HEAD:
  683 changed files (169 added, 21 deleted, 6 renamed), +79k/−12.6k lines,
  a 5 MB body, in a 1,673-file checkout. This is close to the 558-file,
  2.1 MB workspace the poll's caches were first built for. Its objects sit
  behind two levels of alternates: the clone's own, then the checkout's
  line to the main clone (docs/server-git.md). A real checkout has one.
- **synthetic**: 30,000 files in 1,000 folders, packed. The branch edits
  600 of them, adds 20 and renames 5: 625 changed files with a small body,
  spread over 600 folders.

The bench drove `readWorkspaceChanges` with the fake driver of
`changes.test.ts` running each exec through `sh`, as the script tests do,
three polls per row (`diff=1`, `listing=full` unless noted):

| Poll (yaac) | Today | Out | Execs |
|---|---|---|---|
| Cold: no private index | 10.8s | 2.9 MB | 3 |
| Warm index, no caches | 8.7–9.0s | 2.9 MB | 3 |
| Same, `diff=0` | 5.7–6.2s | 260 KB | 1 |
| Idle, held reading and files | 1.2–1.7s | 35 KB | 1 |
| Idle, `diff=0 listing=paths` (the status bar) | 0.9–1.2s | 35 KB | 1 |
| Idle, files only (after a server restart or 5 idle minutes) | 1.9–2.1s | 2.9 MB | 3 |
| Edit to a file the base has (`delta`) | 2.7–3.0s | 38 KB | 1 |
| Edit to a file the agent added | 9.7–10.6s | 2.8 MB | 3 |
| A new untracked file | 9.5–9.8s | 2.8 MB | 3 |
| Two bases alternating, each switch back to `main` | 10.0s | 2.8 MB | 3 |

The steps the script runs, timed alone on the same fixture (median of 5):

| Step (yaac) | Time |
|---|---|
| `add -A`, warm, nothing changed | 0.19–0.22s |
| `write-tree` after an edit | 0.41–0.47s |
| sh + git start-up | 0.07s |
| `diff --raw --no-abbrev --no-renames` base → work (trees only) | 0.37s |
| same, with rename detection | 0.75s |
| `diff --raw` with abbreviated ids | 3.0s |
| `diff --name-status` base → work | 0.82s |
| `diff --numstat` base → work | 2.1–2.8s |
| `diff` body base → work | 4.2s |
| numstat and body of 1 path / 20 paths | 0.17s / 0.36s |
| `ls-files` ignored + untracked folders (`listing=full`) | 0.23–0.33s |

What that says about each layer:

- **The private index's stat cache is essential.** With no index, `add -A`
  hashes every file: 16s for this 1,673-file checkout, and 20–45s for
  20,000 changes under gVisor (docs/file-editor.md). It stays.
- **Object reads are the cost, and trees are cheap.** Reading the whole
  changeset's blobs (numstat, body) costs 6–7s. Reading only the trees
  (`--raw --no-abbrev`) costs 0.37s. Reading a few paths' blobs costs
  0.15–0.2s, most of which is process start-up.
- **The section files** buy the read after a server restart, or after five
  idle minutes drop the held reading: 2.0s instead of 8.8s, when the trees
  have not moved. They hold one answer per kind, so a second base evicts
  them.
- **The held reading and `MODES`** buy the idle poll (1.2s, nothing
  printed) and the edit to a file the base already had (2.7s instead of
  8.8s). The 1.5s the delta adds to an idle poll is mostly start-up: it
  runs seven more git processes at 0.1–0.2s each, plus the `write-tree` an
  edit forces. The delta refuses any changed path that is added,
  deleted or retyped against the base, because rename pairing needs both
  sides in one diff. That covers a new file, and every edit to a file the
  agent created. Those are the commonest edits an agent makes, and each one
  costs a full read, plus the probe.
- **The held listing's paths** save sending 160 KB per poll on the yaac
  fixture and 2 MB on the synthetic one, for one `diff-tree` (0.09s). They
  stay.
- **The `EXTRAS` hash** saves sending the ignored entries and untracked
  folders, which are 326 and 64 bytes on this checkout, since git collapses
  wholly ignored folders to one entry. The walk runs either way.
- **The `--raw` default** abbreviates object ids, and each abbreviation
  probes the object store through the alternates: 3.0s against 0.37s.
  Anything below uses `--no-abbrev`.

### A build directory nobody ignored

The same fixture with an untracked `build/` of 5,000 small files (40 lines
each, in 50 folders), as a build would leave it if `.gitignore` missed it:

| Poll (yaac + `build/`) | Today |
|---|---|
| First poll after the folder appears | 314s |
| Idle | 1.1–1.8s |
| Edit to a file the base has (`delta`) | 2.2s |
| Edit to a file the agent added | 34s |
| First poll after a rebuild rewrites every file | 310s |

In production the exec timeouts (20s warm, 120s cold) cut the first and
last rows off. A killed `add -A` writes no index, but the loose objects it
wrote stay, so each retry has less to write: with 3,000 new files, a retry
after an `add -A` killed at 10s took 151s, and staging them into a fresh
index with every object present took 27s. So the read gets through on the
second or third cold poll, after several minutes of "Git status
unavailable", and the next rebuild starts it again. The edit to an added
file (34s here, 43–46s in a second run) fails every warm poll, and so
succeeds only on every other one, under the cold timeout that follows a
failure. `EXTRAS` plays no part here: an ignored folder is one collapsed
entry, but an unignored one is staged, listed and diffed file by file.

Most of the cost is staging. `add -A` writes every new file as a loose
object into the checkout's object store, one file create on NFS each, and
the reads that follow come back from those loose objects. Staging 1,000 new
files, alternating the two setups twice:

| 1,000 new files | `add -A` | `write-tree` | numstat of them |
|---|---|---|---|
| Objects into the checkout's store (today) | 9.5–11.3s | 0.7–0.9s | 1.7–2.1s |
| Objects into pod-local scratch | 1.8–2.4s | 0.4–0.5s | 0.8–1.2s |

A second run, on another workspace of the same kind, measured 50.3–51.5s
against 3.7–3.8s, with numstats of 3.1–3.4s against 0.38–0.40s. So staging
costs 10–50ms per new file today, depending on the node, and 2–3.7ms when
its objects go to scratch.

## Design

### Every file's diff is a function of its raw line

`git diff --raw --no-abbrev` prints one line per file: both modes, both
blob ids, the status (with a rename's score) and the path or paths. A
file's numstat row and its body part are a pure function of that line,
plus the diff settings `SETTINGS` hashes. Which attributes apply depends
on the path, and the path is in the line. The working tree's blob id is
taken after clean filters and `autocrlf`, so those are in the key too.

`SETTINGS` today hashes `diff.*` config and every attributes source. It
gains `core.bigFileThreshold` (a blob over it diffs as binary), the
`submodule.*` config and the `.gitmodules` blob from the private index (a
submodule's `ignore` hides its gitlink). One input stays outside it: a
textconv program's own output, which is taken to depend only on the blob.
A changed program shows once its driver's config or the attributes naming
it change. Editing any of these misses every entry at once, so the next
poll pays a full fill, as it pays a full read today. The raw diff itself reads
only trees, apart from rename detection, which reads the added and deleted
files' blobs. So the read splits into a cheap **scan** that lists raw lines,
and a **fill** that reads blobs only for lines the server has not seen.

### Scan: one exec, under the run lock

The script keeps everything up to `SETTINGS`: the run lock, the seeded
private index, staging with its retries, the trees, `BASE`/`FORK`/`REF`. It
then prints the raw diff of each pair the read needs: committed (base →
HEAD), staged (HEAD → the agent's tree), unstaged (the agent's tree → the
working tree, `--no-renames`) and the base diff (base → the working tree).
It skips any pair the server says it already holds. A raw diff is fixed
by its two trees and `SETTINGS`, since `diff.renames`, `diff.renameLimit`,
`diff.orderFile` and a submodule's `ignore` all change its lines or their
order. So the server names each pair it holds with the settings it was
read under (`A..B:SETTINGS`), and the script prints every pair whose name,
with its own `SETTINGS`, is not among them. An idle poll prints none, as
`same` does today. The listing and the output's paging work
as they do today. Staging changes in two ways, covered below: its objects
go to scratch, and an untracked folder over the size limit is left out.

### Entry cache: in the server, keyed by content

Per workspace, the server keeps two maps:

- **raws**: `<A>..<B>:<SETTINGS>` → the pair's parsed raw lines;
- **entries**: `SETTINGS` plus raw line → the file's counts and, once read,
  its body part (cut at the per-file cap, as today).

Neither is tied to a base or a reading, and both are bounded by what is on
screen. `raws` keeps, per base, only the four pairs of its latest reading,
and the pair of each `compare` range read in the last five minutes; a
reading replaces its base's pairs. After each read, the entries no held
raw names are dropped. So an agent rewriting one large file every few
seconds leaves one entry for it, not one per edit, and a workspace holds at
most its bases' and ranges' changesets, with up to 2 MB of parts each. Both
maps go after five idle minutes, as the held reading does today, and
teardown drops them (`forgetWorkspaceChanges`).

Entries are per workspace and never shared by blob id across workspaces or
projects, though that would look like an easy saving: every entry is the
output of a script run in that workspace's sandbox, so its agent can make
an entry say anything, and a shared one would let it put that in another
workspace's diff.

### Surviving a server restart

The entries are also kept in the workspace's scratch, as
`yaac-changes.entries` beside the private index: one JSON line per entry,
holding its key, counts and part. The server writes the file through the
scan's stdin. Each scan appends the entries filled since the last one, and
when the file passes twice the size of the live entries, it is replaced by
them instead. When the server holds no entries for a workspace (after a
restart, or after five idle minutes), its next scan prints the file back,
paged as any large output is, before its raws. A line cut short by a killed
write is dropped on load, and the file is replaced, so the next append
never lands on the end of a cut line.

Keeping the file in the workspace rather than on the server's disk keeps
the agent's uncommitted files, including a `.env` it wrote at a path no
ignore pattern covers, inside the sandbox, as they are today. The server's
disk would add no protection: every entry is the fill's output, which the
agent can already shape. A server restart does not restart the pod, so the
file is still there for it. The file dies with the pod, like the private
index beside it, so nothing has to delete it at teardown or sweep it at
start-up. The scratch-object cap below leaves it alone, since entries
describe content by blob id and hold no object.

The raw lines are not stored: the first scan after a restart prints every
pair again (0.1–0.75s on these fixtures). So a restart costs one scan, the
file read back (a few MB, about 2s, as the section files cost today), and
fills for what changed while the server was down. Today it costs 2.0s when
the trees have not moved, and a full read (8.8s) when they have.

### Fill: a second exec, only for lines the cache lacks

The server collects the lines it lacks, per pair, and reads them in one exec,
outside the run lock, since it reads only immutable trees: `git diff
--numstat` over their paths, and with a body wanted, the capped body for
those before the answer's cap. Over 300 lines, it diffs the whole pair
instead. The pathspec holds both paths of each rename, so git pairs them as
the whole diff did. Every added and deleted file in the set is either one of
those pairs or was unpaired in the whole diff, and rename detection only
pairs an added file with a deleted one, so the smaller candidate set gives
the same pairs. On this fixture, a pathspec of the 6 renames, 30 additions
and 21 deletions gave rows byte-identical to the whole diff's. The one known
divergence is `diff.renameLimit`, where the whole diff gave up on inexact
pairing and the subset would not. So the server checks the fill's rows
against the lines it asked for, and reads the whole pair on a mismatch.
`readChangeDiffs` is the same script with `skip`, so the two merge. A tree
or blob the fill cannot read (scratch was capped or cleared mid-read) is
answered as a reading that is gone, the 404 the client already follows
with a new poll, rather than as a git error.

A part the total cap cut is not cached, and neither is any part after it.
The cut lands at least 1.75 MB into the parts read, past the answer's 1 MB
cap, so no later poll asks for those parts again. They load through `POST
changes/diff` as they do today.

### Assembly

`files` are the base diff's lines in git's order, with counts from the
cache. The stages are looked up in the stage pairs' own lines; untracked
files are the unstaged pair's `A` lines. The body is the parts in order up
to the cap, with `truncated` as today. The answer still names its reading
by `base` and `work`.

### What the prototype costs

The scan and the fill run as shell scripts against the yaac fixture,
measured the way the bench measures today's script:

| Poll (yaac) | Today | Proposed |
|---|---|---|
| Idle | 1.2–1.7s | the same: no pair moved, nothing printed |
| Edit to a file the base has | 2.7–3.0s | 2.5–2.7s scan + 0.35s fill |
| Edit to an added file, or a new file | 9.5–10.6s | 2.5–2.7s scan + 0.35s fill |
| Two bases, switching back | 10.0s | idle cost: both bases' pairs and entries are cached |
| First read after a server restart | 1.9–2.1s; 8.8s if the trees moved | a scan, the entry file read back, and a fill for what moved |

| Poll (synthetic) | Today | Proposed |
|---|---|---|
| Idle | 2.6–5.5s; the status bar's 1.3–1.5s | the same |
| Edit to a file the base has | 3.1–4.9s | 2.6–2.7s scan + 0.3–0.37s fill |
| Edit to an added file, or a new file | 4.4–7.7s | 2.6–2.7s scan + 0.3–0.37s fill |
| Two bases, switching back | 4.6s | idle cost |
| Warm-index full read | 5.0–10.3s | the same |

The synthetic changeset's files are small, so reading the whole of it is
cheap (numstat 0.53s, body 0.57s), and its idle poll is mostly the checkout
walks: `add -A` (0.65s) and `listing=full`'s ignored and untracked walk
(0.9–1.0s). Its base-diff tree scan, 625 files over 600 folders, takes
0.08–0.11s, so the scan grows with the changeset's folders far more slowly
than the reads it replaces. The "Today" columns run the real code. The
"Proposed" ones are the prototype's shell steps, which leave out the
server's parsing.

### More than one base

Nothing in the cache belongs to a base. A range pane's pairs and entries
sit beside the workspace's own, and any file whose blobs are the same under
both shares an entry. So a range pane ending at the working tree costs its
own fills once, and its polls after that cost what an idle one does. The
one remaining per-base cost is that `runChangesRead` joins only reads
against the same base. A later change could let one scan list several
bases' pairs, so two bases share one `add -A`.

### Ranges between two refs

`compare` (`readComparison`) diffs a merge base against a commit, with no
working tree, and today reads the whole diff every time: once for a range
between two commit ids, every 30 seconds for one naming a branch or HEAD.
Both ends are commits, so the same machinery serves it with no scan: its
script resolves the refs and prints the one raw diff, the server fills
what its entries lack, and assembly builds the answer. A range read before
costs only its raw, and one that shares files with the workspace's own diff
shares their entries. Its own numstat, name-status and body parsing go.

### Staging into scratch objects

The scan runs git with `GIT_OBJECT_DIRECTORY` set to a directory beside
the private index, and the checkout's own object store in
`GIT_ALTERNATE_OBJECT_DIRECTORIES`. The checkout's store keeps its own
alternates line to the main clone (docs/server-git.md), so reads find
every object in scratch, the checkout or the main clone. Writes, meaning the
blobs `add -A` hashes and the trees `write-tree` makes for the agent's
index and the working tree, land in pod-local scratch instead of on NFS. A
blob the checkout already has is not written again, though git freshens it
(an mtime update, still an NFS metadata write). The fill and
`readChangeDiffs` set the same two variables, since the trees they diff
live there. That makes new files 5–14× cheaper to stage, and it stops
polls leaving loose objects in the checkout, which they do today on every
edit until git prunes them.

A pod's scratch is held in the sandbox's memory, so the directory is
capped. When it passes 256 MB, the scan deletes it together with the
private index and seeds the index again. That costs one cold staging, now
done at scratch speed. The cached entries stay valid, since a blob id names
the same content wherever the blob is stored. A pod restart clears
scratch too, so a reading's trees can be gone, which `POST changes/diff`
already answers with 404 and the client follows with a new poll.

The private index can still name a blob that lives only in the checkout as
an unreachable loose object: the agent ran `git add f; git reset f`, and a
poll staged `f` before that. The agent's `git prune` or `gc --prune=now`
then deletes it. `write-tree` still succeeds from the index's cached trees,
but every diff that reads the blob fails with `unable to read`. Today's
script has the same hole, wider, since every blob a poll writes is an
unreachable loose object in the checkout that `gc --auto` prunes after two
weeks. Scratch objects narrow it to blobs the agent itself wrote and
dropped. The scan treats a missing object as it treats the cap: it deletes
the scratch objects and the private index, and seeds again.

### An untracked folder too large to stage

At 2–3.7ms a file, a 30,000-file build output would still take one to two
minutes to stage, and put 30,000 lines in every listing and raw diff. So
before staging, the scan lists the untracked files that no ignore pattern
covers (`ls-files -z -o --exclude-standard` against the agent's index),
and an `awk` counts them under each folder that holds them, at every
depth. Folders are taken deepest first. A folder whose count is over 2,000,
less what folders already taken below it hold, is **skipped**.

The count has to be of untracked files that are not ignored, and of every
folder, not only those git collapses. `ls-files -o --directory` collapses
a new package whose `node_modules` is ignored into one entry, and `find`
would count every installed file in it; and it never collapses a `build/`
that holds a tracked `.gitkeep`. `ls-files -o --exclude-standard` does not
walk into ignored folders, so it costs about one more walk of the working
tree:

| Fixture (yaac) | Count |
|---|---|
| No new folders | 0.14–0.28s |
| `build/` (5,000 files beside a tracked `.gitkeep`) and `newpkg/` (3 sources, 2,500 files in an ignored `node_modules`) | 0.28s warm, 0.74s the first time |

It found `build/` (5,000) and counted 3 in `newpkg/`, which is staged and
shown as today.

A skipped folder is left out of `add -A` with a literal `:(exclude)`
pathspec. Its entries in the private index are then reset to the agent's
tree (`restore --staged --source=<agent>`), which drops any untracked ones
an earlier poll staged, and `add -u` stages its tracked files' edits. With
`build/` skipped, staging took 0.27s, and 0.20s idle. The folder is named in
`skipped` on the answer. The Changes pane shows it as one untracked row,
"over 2,000 files, not diffed", and the explorer as a folder whose children
are read on expand, the way it shows an ignored folder. Nothing is lost:
the agent's own `git status` still sees every file, the folder's tracked
files are diffed as usual, and once it is ignored, deleted or committed it
leaves the limit. The limit is a constant beside the others in
`changes.ts`.

## Alternatives weighed

**Deriving base comparisons from HEAD → working tree.** The idea is to
cache base → HEAD by its pair, read HEAD → working tree each poll, and
combine them. For a file only one half touches, that half's row and part
are exact, since the other side's blob is the same. Everything else needs
work:

- *Counts* do not add across the halves: a line a commit adds and the
  working tree removes shows in both halves and in neither total. Every
  path both halves touch needs its own base → working tree diff.
- *Renames* pair across the halves: a file deleted in a commit and
  re-added under a new name in the working tree pairs only in the combined
  diff. Pairing has to run again over the union of added and deleted files,
  which reads their blobs, the same as the direct diff.
- *Bodies* need stitching in git's byte order of paths, which is what
  `pathBytes` and `splice` do today.

All of that only rebuilds the direct raw diff, which costs 0.37–0.75s from
trees alone. The entry cache already gives what the derivation was for: a
file untouched since HEAD keeps its raw line, so its entry is reused on
every poll.

**Naming the section files by their keys** (`.lists.<base>.<work>`, keeping
the newest few). This is the smallest change that stops two bases evicting
each other. It keeps `MODES`, the splice and the delta's gap on added and
new files, and it adds a sweep. It is worth doing only if this plan is not.

**Leaving the body out of the poll.** The Changes pane would load every part
through `POST changes/diff`, as it already does past the cap, and the entry
cache would hold only counts. Cmd/Ctrl-F would then search only the parts
loaded so far, where it now searches the first megabyte at once, so the
body stays in the poll.

**One exec, the cached keys sent on stdin.** `exec` takes stdin, so the
server could send the lines it holds and the script could fill in the same
run, saving the fill's start-up (about 0.1s). That costs the payload on
every poll and puts the set logic in awk. Not worth it unless the second
exec shows up in measurements over a slower network.

**Dropping the `EXTRAS` hash.** It saves 390 bytes per explorer poll on
this checkout, but an ignore pattern matching files beside sources (`*.o`
next to every `.c`) lists each one, and only the hash stops that list being
sent on every poll. It is a few lines, so it stays.

## What gets deleted, and what is added

Counted against `changes.ts` as it stands (1,106 lines), in source lines,
comments included:

| Deleted | Lines |
|---|---|
| Script: `cached`, `hit`, `pd`, the delta probe, `bdelta`, the `MODES` cases, `CHANGED` | about 40 |
| The script's comment on section files and `MODES` | about 30 |
| `BaseDiff`, `HeldReading`, `patched`, `splice` | about 45 |
| `readRun`, replaced by the raw parser and assembly below | about 120 |
| The held-reading arguments of `buildChangesScript` and `readWorkspaceChanges` | about 10 |
| `readComparison`'s numstat, name-status and body sections and their parsing | about 25 |
| **Total** | **about 270** |

| Added | Lines |
|---|---|
| Scan: the raw diffs and their held-pair check, the wider `SETTINGS` | about 8 |
| Raw parser and assembly | about 45 |
| `raws` and `entries`, with their pruning | about 25 |
| The entry file: stdin append, replace, read back, cut-line handling | about 25 |
| Fill: lines missing per pair, pathspec or whole pair, row check and fallback, parsing into entries | about 55 |
| Scratch objects: the variables, the cap and the missing-object reseed | about 8 |
| Folder limit: the count, the exclusion, `skipped` | about 15 |
| Comments for all of the above | about 40 |
| **Total** | **about 220** |

So `changes.ts` ends about 50 lines shorter. Outside it, `skipped` adds
about 25 lines (its type, the Changes pane's row, the explorer's lazy
folder). In the tests, the `MODES` and section-file tests (about 170 lines)
give way to about as many: an equivalence test that reads after each kind
of change and compares against an uncached read, a fill test, a folder
limit test and a restart test. The core swap alone would save about 120
lines; the restart file, the scratch objects and the folder limit spend
most of that. The case for the plan is what it fixes, not its size.

## Risks

- **Every edit poll rescans the base diff's trees.** That is 0.37s on the
  yaac fixture (0.75s with renames to pair) and 0.1s on the synthetic one,
  where today's delta probe takes 0.07–0.09s. Rename pairing reads every
  added and deleted file left unpaired after exact matching, on every edit
  poll. If a changeset with hundreds of both makes that slow, the pairing
  can be cached by the set of added and deleted lines.
- **Raw lines cost about 145 bytes per file** (100 KB for this fixture's
  base diff). A committed changeset of more than about 15,000 files passes
  the 2 MiB page and pages on every edit poll; the folder limit keeps
  untracked output out of it. If that case matters, the scan can print only
  the lines that differ from the pair the server holds for the same base,
  which is a set difference of lines.
- **Pathspec fills depend on rename pairing being local.** The fill checks
  its rows against the lines it asked for and falls back to the whole pair
  on a mismatch, so a divergence costs time, not correctness.
- **A second exec on every poll that changed something** adds its
  start-up, about 0.07s plus the exec's own round trip.
- **Scratch uses sandbox memory**: the objects up to their 256 MB cap,
  and the entry file up to twice the live entries.
- **The folder count is one more walk of the working tree on every poll**,
  0.14–0.28s on the yaac fixture.
- **A folder over the limit shows no diff,** including one the agent means
  to commit. Its row says why, and the agent's own `git status` and commits
  are unaffected.

Nothing needs a legacy-compat shim. The old section files sit in scratch
until the workspace is torn down, and no code reads them.

## Migration order

1. **Land the bench** as a test skipped unless `BENCH_REPO` is set, with
   the fixture builders (the two above, and the untracked `build/`), so
   every later step is measured the same way. Also run it where the NFS
   server is across a real network (EFS, a Hetzner volume), where each
   uncached read costs more than it does here.
2. **Stage into scratch objects.** It is independent of the cache and
   speeds up today's script as it is: the variables in the script and in
   `readChangeDiffs`, the cap and the missing-object reseed. Update
   file-editor.md "Changes" with it: the `work` tree no longer goes into
   the checkout's object store, and "a killed one also leaves it as it
   was" holds for the index only.
3. **Limit untracked folders**, after step 2: the limit is sized at scratch
   speed, and at 10–50ms a file a folder just under it would time out
   every first poll. It adds `skipped` to `WorkspaceDiff`, its row in the
   webapp, and its paragraph in file-editor.md.
4. **Replace the poll's caching** (scan, entry cache and its file, fill,
   assembly) in one change. `MODES` spans every part of the diff, so it
   cannot be retired a part at a time. Merge `readChangeDiffs` into the
   fill. Rewrite file-editor.md "Changes" and "Ranges" in the same change.
5. **Move `compare` onto the fill and the entry cache.**
6. Later, if wanted: **let one scan serve several bases**.

Steps 2 and 3 are the urgent ones: together they end minutes of failed
polls on an unignored build directory. Step 4 ends the eviction a range
pane ending at the working tree causes today.

## Decided

1. **The body stays in the poll**, since find across diffs searches it.
2. **A server restart must not cost a full read**, hence the entry file
   in the workspace's scratch.
3. **An unignored build directory must not be expensive**, hence the
   scratch objects and the folder limit, and the `EXTRAS` hash stays.
4. **The folder limit is 2,000 files**, which keeps staging to 4–7s at
   scratch speed (2–3.7ms a file), under the 20s warm timeout.
