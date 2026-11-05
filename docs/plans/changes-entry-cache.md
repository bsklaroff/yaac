# The changes read: one cache keyed by content

The changes read (`changes.ts` in `#domain/workspaces`, docs/file-editor.md
"Changes") caches its work in three layers: five section files beside the
private index, each holding one answer keyed by the trees it was read from;
the server's held reading, which the script patches through the `MODES`
same/delta/full protocol; and the held listing with its `EXTRAS` hash. Each
layer has one slot per workspace, so a second base polling beside the
default evicts the first on every alternate poll. This plan replaces the
first two layers with one cache, keyed by what each file's diff is a
function of. It handles any number of bases, covers edits the delta
misses, and needs less code.

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
  behind two levels of alternates; a real checkout has one.
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
  costs more than reading with no caches at all, because the delta probe
  runs first.
- **The held listing's paths** save sending 160 KB per poll on the yaac
  fixture and 2 MB on the synthetic one, for one `diff-tree` (0.09s). They
  stay.
- **The `EXTRAS` hash** saves sending the ignored entries and untracked
  folders, which are 326 and 64 bytes on this checkout, since git collapses
  wholly ignored folders to one entry. The walk runs either way.
- **The `--raw` default** abbreviates object ids, and each abbreviation
  probes the object store through the alternates: 3.0s against 0.37s.
  Anything below uses `--no-abbrev`.

## Design

### Every file's diff is a function of its raw line

`git diff --raw --no-abbrev` prints one line per file: both modes, both
blob ids, the status (with a rename's score) and the path or paths. A
file's numstat row and its body part are a pure function of that line,
plus the diff settings `SETTINGS` already hashes. Which attributes apply
depends on the path, and the path is in the line. The raw diff itself reads
only trees, apart from rename detection, which reads the added and deleted
files' blobs. So the read splits into a cheap **scan** that lists raw lines,
and a **fill** that reads blobs only for lines the server has not seen.

### Scan: one exec, under the run lock

The script keeps everything up to `SETTINGS`: the run lock, the seeded
private index, staging with its retries, the trees, `BASE`/`FORK`/`REF`. It
then prints the raw diff of each pair the read needs: committed (base →
HEAD), staged (HEAD → the agent's tree), unstaged (the agent's tree → the
working tree, `--no-renames`) and the base diff (base → the working tree).
It skips any pair the server says it already holds. A raw diff never
changes for a given pair of trees, so the server names the pairs it holds
(`A..B`) as arguments, and the script prints only the others. An idle poll
prints none, as `same` does today. The listing works as it does today, less
the `EXTRAS` hash. The output is paged as today.

### Entry cache: in the server, keyed by content

Per workspace, the server keeps two maps:

- **raws**: `<A>..<B>` → the pair's parsed raw lines, a few pairs per
  workspace;
- **entries**: `SETTINGS` plus raw line → the file's counts and, once read,
  its body part (cut at the per-file cap, as today).

Neither is tied to a base or a reading. One LRU byte budget covers all
workspaces, with no idle expiry, and teardown drops a workspace's share
(`forgetWorkspaceChanges`). The base diff's entries are at most the 2 MB
in-workspace body cap plus their counts, so a 64 MB budget holds dozens of
workspaces.

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
`readChangeDiffs` is the same script with `skip`, so the two merge.

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
| First read after a server restart | 1.9–2.1s | the warm-index full read, 8.7–9.0s |

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

Nothing in the cache belongs to a base. A second base's pairs and entries
sit beside the first's, and any file whose blobs are the same under both
shares an entry. So the two-ref Changes pane needs no slot logic. The one
remaining per-base cost is that `runChangesRead` joins only reads against
the same base. A later change could let one scan list several bases' pairs,
so two bases share one `add -A`.

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
through `POST changes/diff`, as it already does past the cap. The entry
cache would then hold only counts, and the poll's body handling would go:
`capped` in the poll, the `diff` reader in `useWorkspaceChanges`, and
`useChangeDiffs`' merging of the polled body with loaded parts. The
pane's first diffs would arrive one batch after the file list, which on a
large changeset beats today's first open of the pane: that open reads the
whole body unless a reading is held with one. The cost is that Cmd/Ctrl-F
searches only the parts loaded so far, where it now searches the first
megabyte at once. This is a product choice, listed under Decisions.

**One exec, the cached keys sent on stdin.** `exec` takes stdin, so the
server could send the lines it holds and the script could fill in the same
run, saving the fill's start-up (about 0.1s). That costs the payload on
every poll and puts the set logic in awk. Not worth it unless the second
exec shows up in measurements over a slower network.

## What gets deleted

- The section files and their helpers: `.committed`, `.staged`,
  `.unstaged`, `.lists`, `.body`, `.delta`, `.paths`, `.dbody`, `.extras`,
  and `cached`, `hit` and `pd`.
- `MODES` and everything that decides it: the delta probe, `bdelta`,
  `CHANGED`, the `patch` run, the blank base the server sends when its body
  does not cover a run, and the stage and base-diff markers. A single raw
  marker replaces those.
- `HeldReading`, `BaseDiff`, `splice`, `patched` and the `MODES` half of
  `readRun`. `chunksOf` and `joinChunks` stay for the fill and assembly, and
  `pathBytes` stays for `readChangeDiffs`.
- The `EXTRAS` hash and the listing's held extras.
- `HELD_IDLE_MS`, since the LRU budget replaces it.
- In `changes.test.ts`, the `MODES` assertions and the section-file test.
  Two tests replace them: one reads after each kind of change and compares
  against an uncached read, and one shows a fill reading only the lines the
  cache lacks.

The estimate is 150–200 fewer lines in `changes.ts`, about a sixth, and
more in its tests and in file-editor.md's "Changes". The script loses about
35 of its 148 lines. Leaving the body out of the poll would take another
80 or so from the server and 40 from `useChangeDiffs`.

## Risks

- **A server restart costs one full read per polled workspace** (8.8s on
  the yaac fixture). Today the section files make it 2.0s when the trees have
  not moved. The cold-read timeout (`READ_TIMEOUT_MS.cold`) still covers
  that first read.
- **Every edit poll rescans the base diff's trees.** That is 0.37s on the
  yaac fixture (0.75s with renames to pair) and 0.1s on the synthetic one,
  where today's delta probe takes 0.07–0.09s. Rename pairing reads every
  added and deleted file left unpaired after exact matching, on every edit
  poll. If a changeset with hundreds of both makes that slow, the pairing
  can be cached by the set of added and deleted lines.
- **Raw lines cost about 145 bytes per file** (100 KB for this fixture's
  base diff). A changeset of more than about 15,000 files passes the 2 MiB
  page and pages on every edit poll. Idle polls print none.
- **Pathspec fills depend on rename pairing being local.** The fill checks
  its rows against the lines it asked for and falls back to the whole pair
  on a mismatch, so a divergence costs time, not correctness.
- **A second exec on every poll that changed something** adds its
  start-up, about 0.07s plus the exec's own round trip.

Nothing needs a legacy-compat shim. The old section files sit in scratch
until the workspace is torn down, and no code reads them.

## Migration order

1. **Land the bench** as a test skipped unless `BENCH_REPO` is set, with
   the two fixture builders, so every later step is measured the same way.
   Also run it where the NFS server is across a real network (EFS, a
   Hetzner volume), where each uncached read costs more than it does here.
2. **Replace the poll's caching** (scan, entry cache, fill, assembly) in
   one change. `MODES` spans every part, so it cannot be retired a part at
   a time. Merge `readChangeDiffs` into the fill. Rewrite file-editor.md
   "Changes" in the same change.
3. **Drop the `EXTRAS` hash.**
4. **Build the two-ref Changes pane** on top. It needs nothing from the
   cache.
5. If chosen, **leave the body out of the poll**, and **let one scan serve
   several bases**.

Step 2 should come before step 4, so the new pane never runs on the
one-slot caches.

## Decisions

1. **The body in the poll, or on demand?** Recommended: keep it in the poll
   for now (as in the design above), since find across diffs depends on it,
   and revisit once the entry cache has landed.
2. **Is a full read per workspace after a server restart acceptable?**
   Recommended: yes. If not, the fill could also write what it read to a
   scratch file for the server to load on its first poll, which gives back
   some of the code saved.
3. **Drop the `EXTRAS` hash?** Recommended: yes. A checkout with thousands
   of ignored files outside ignored folders would then send that list on
   every explorer poll.
