# File editor panes: browse and edit a worktree's files in the webapp

## Context

Today the webapp shows a worktree's files only as a diff (the Changes pane,
`WorktreeChanges`) or through a terminal. You can't open a file the agent
hasn't touched, and you can't make a one-line fix without a shell and `vi`.
The goal is a built-in editor that is as small as it can be while still
being useful, built from packages the frontend already ships, and fitting the
existing pane layout the way Changes does, except that several files can be
open at once.

Most of what this needs already exists:

- **CodeMirror 6** is a dependency already (`@uiw/react-codemirror` plus
  eight `@codemirror/lang-*` and `legacy-modes` packages). `ui/CodeEditor`
  wraps it for the settings panel, and `settings/FileEditor` adds a
  load/dirty/save lifecycle around it for build files.
- **`#lib/highlight`** already maps ~30 languages from a path
  (`languageForPath`) to Lezer/stream parsers for the diff view.
- **The layout** (`#lib/layout`) is already an editor-group system: columns
  of tabbed panes whose targets are plain strings, with drag, tiles/tabs
  modes, keyboard cycling, and persistence in localStorage. Special panes
  (`changes`, `preview`, `acp:<id>`) prove that a target without a tmux
  window behind it works.
- **The server already owns the checkout on disk.** `worktreeDir(slug, id)`
  is GLOBAL-tier on k8s, which the server pod mounts, and it is the host
  checkout itself under containerless. The server creates every checkout
  there with `git worktree add` + `checkout --force` (`#domain/git`), and
  `#domain/worktrees` is the layer that owns what a worktree keeps on disk.

## How editors do it

Every mainstream editor (VS Code, and so Codespaces, Gitpod and Cursor;
Zed; JetBrains; StackBlitz; CodeSandbox; JupyterLab) splits the UI the same
way:

- **The file tree is its own view, separate from the editors.** It is docked
  beside the editor area, never repeated inside each editor.
- **Each open file is a tab in an editor group**, and you see several files
  at once by splitting groups. Opening a file from the tree puts it in the
  *active* group.
- **The tree honors the ignore rules.** VS Code's `files.exclude` and
  quick-open both respect `.gitignore`, so `node_modules` stays out of the
  way.
- **Saving is explicit (Cmd/Ctrl-S), or automatic after a short idle**
  (VS Code's `files.autoSave: afterDelay`, 1 s by default). Unsaved
  buffers show a dot in place of the tab's close button, and closing one
  asks first.
- **Changes on disk are watched.** A clean buffer reloads silently. A dirty
  one gets a "file changed on disk" prompt (reload / overwrite / compare),
  and a save made against a stale version is refused instead of silently
  clobbering the newer one.
- **Quick-open** (Cmd-P) is a fuzzy filter over the ignore-aware file list.
  It is how most people open files, and it is the only practical way on a
  small screen.
- **Preview tabs**: a single click in the tree opens a temporary tab that
  the next single click replaces, while editing or double-clicking pins it.
  This keeps browsing from spawning dozens of tabs.

yaac's layout already *is* the editor-group half of this, so the design maps
straight onto it.

## Decisions

### 1. The explorer is its own pane, and each open file is its own pane

- **`files`**: the explorer pane. There is one per worktree, like `changes`.
- **`file:<path>`**: one editor pane per open file, where `<path>` is
  relative to the workspace root. These are ordinary layout leaves, so
  side-by-side files, tabs, drag, Alt-W, tab cycling and persistence across
  reloads all come free.

The alternative is a single "Files" pane holding a tree rail plus its own
internal tab strip, a mini-IDE per pane. It was rejected because it nests a
second tab system inside the layout's, which means duplicating every
tab/close/cycle/drag behavior, and because viewing two files side by side
would still need a way out to a second pane.

**Equal-width columns stay.** An explorer column takes a full share of the
width, where a tree only wants about 250px, and that is accepted: no
per-column width weights or splitters. The user can tab the explorer into the same column as a
file, and the explorer's filter box works as quick-open (below), which
covers tabs mode and mobile.

### 2. CodeMirror 6, not Monaco

Monaco is VS Code's editor, but it adds megabytes plus web workers and needs
Vite plumbing. CodeMirror is already shipped, renders large files through
its viewport, and has the official `@codemirror/merge` for a later "compare
with disk" view. Staying on CodeMirror also means one language table for
both the diff view and the editor (see "Consolidation" below).

### 3. The tree is hand-rolled over one flat, gitignore-aware path list

One route returns every path from
`git ls-files -z --cached --others --exclude-standard`, minus
`git ls-files -z --deleted` (tracked files that were removed from disk).
The client builds the tree from that list. This approach:

- gets `.gitignore` handling right for free, with no JS `ignore`
  reimplementation;
- costs one refresh (four concurrent read-only git calls, see "Listing")
  instead of one request per expanded directory, as lazy `readdir` would;
- lets the explorer's filter double as quick-open, because the client
  already holds every path.

The tree UI itself is small: expand/collapse, click to open, and a filter
that switches to a flat list of matches capped at 200. Only rows under
expanded folders render, so a 50k-file repo with its folders collapsed is a
handful of DOM nodes, and no virtualization is needed. For accessibility and
future drag-and-drop, the swap-in is `@headless-tree/react` (headless, so it
fits the existing Tailwind styling). `react-arborist` was considered and
passed over: it brings its own drag-and-drop, rename, virtualization and
styling assumptions, none of which this plan needs.

Accepted limits:

- Empty directories come from a separate git call, because `ls-files`
  has no entry for them (see "Listing" below).
- Ignored files (`node_modules`, a local `.env`) are hidden by default.
  A **"show ignored" toggle** in the explorer's header reveals them (see
  "Ignored files" below).
- A submodule appears as a single entry that can't be opened.
- Symlinks are followed when they resolve inside the worktree (see
  Confinement). The tree shows them with a link glyph, and expands a
  directory link from the listing it already has.

### 4. File I/O runs on the server's own filesystem, against `worktreeDir`

The server reads and writes the checkout directly with `fs`, in
`#domain/worktrees`. There is no driver verb, no in-workspace script and no
contract change, and it works the same under both drivers.

**Ownership is already right by construction.** Nothing has to adopt the
worktree's user, because the server already is that user:

- On k8s, the server Deployment, every worktree pod and the proxy all take
  their identity from `hostUidSecurityContext()`: the installing host's
  uid:gid, plus supplementary group 0. A file the server writes lands with
  exactly the owner and group a write from inside the pod would.
- The server already writes every tracked file in a checkout
  (`addWorktree`'s `checkout --force`), so an editor save is no different
  from what creation already does.
- On macOS, virtiofs performs every hostPath read and write as the host
  user anyway (docs/server-in-cluster.md, "The uid everything runs as").
- Under containerless, the server and the worktree are the same host
  process user.

**The listing needs an explicit git dir.** The in-pod setup rewrites the
checkout's `.git` file to the container's own view
(`gitdir: /repo/.git/worktrees/<id>`, see `buildWorktreeLinkExec`). So a
plain `git ls-files` run from the server fails with "not a git repository".
Naming both halves works:

```
git --git-dir=<repoDir>/.git/worktrees/<id> --work-tree=<worktreeDir> \
    ls-files -z --cached --others --exclude-standard
```

This works because the admin dir's `commondir` is the relative `../..`.
It is checked against a checkout whose `.git` points at a nonexistent
`/repo/...`: it lists tracked and untracked files, honors `.gitignore`,
and `-d` reports deleted ones. The call belongs in `#domain/git`, the one
process boundary onto git. It is read-only: it takes no index lock and
writes no config, so it cannot trip the virtiofs stale-inode problem that
`addWorktree`'s `--no-track` note describes.

**What this buys over the in-workspace path:**

- Stopped worktrees are browsable and editable for free, because the
  checkout stays on disk after a stop (docs/worktree-storage.md).
- There is no pod exec per poll.
- Reads and writes are binary-safe with no base64 or size juggling.

**What it costs:**

- **Path confinement becomes a real security boundary** (see below).
  Under k8s the agent is sandboxed and the server is not: the server pod
  can see `server-local/` (the database and the secrets key). A symlink
  the agent plants in the checkout must never lead a server-side read or
  write out of it.
- **It couples to cloud-k8s step 9.** Node-local checkouts would take the
  checkout off the server's filesystem. `worktreeDir`'s own doc comment
  already notes that the move needs worktree creation to run on the node.
  The editor becomes a second thing that step has to give an in-pod path,
  so that step now lists it.

### 5. Debounced autosave plus explicit save, with optimistic concurrency

Edits save themselves **1 s after the last keystroke**, and Cmd/Ctrl-S or
the Save button saves immediately. Both go through one save path, so they
differ only in when it runs. Autosave is always on, with no setting to turn
it off: an explicit save stays available for "now". What autosave may and
may not do is under "Saving" in the editor pane. In short, it never
resolves a conflict and never recreates a deleted file. Only an explicit
action does either.

The agent edits the same files, so conflicting writes are the normal case,
not a corner case.

- **The version** of a file is the sha256 of its bytes, computed in Node.
- **A read** returns `{ version, size, binary, content }` and accepts a
  `known` version. When the file still matches, the response carries no
  content. A cheaper `mtimeMs:size` pre-check could skip even the hash, but
  a hash of at most 1 MiB is not worth the extra code.
- **A save** sends `baseVersion`. The server re-reads and re-hashes the
  file under a per-file mutex. On a mismatch it refuses, and the route
  answers **409 CONFLICT** with the current version. The window in which
  the agent could write between that check and the server's write is the
  microseconds between two local syscalls. `baseVersion: null` means
  "create", which conflicts if the file already exists. A non-null
  `baseVersion` against a file that no longer exists is also a conflict,
  answered with `version: null`. A save only ever updates the file it
  started from, which is what stops autosave from resurrecting a deleted
  file.

## Server

### Routes (`api/routes/worktrees.ts`, beside `/:id/changes`)

| Route | Body / query | Answer |
|---|---|---|
| `GET /worktree/:id/files` | none | `{ paths: string[], symlinks: Record<string, { target: string \| null, dir: boolean }>, truncated: boolean }` |
| `GET /worktree/:id/file` | `?path=&known=` | `{ path, version, size, binary, content: string \| null }`; `content` is omitted when `known === version`, and `null` when binary or over the cap |
| `PUT /worktree/:id/file` | `{ path, content, baseVersion: string \| null }` | `{ path, version, size }`, or 409 `{ version: string \| null }` (`null`: the file is gone) |
| `GET /worktree/:id/dir` | `?path=` | `{ entries: { name, dir, symlink?: { target: string \| null, dir: boolean } }[], truncated: boolean }`, the immediate children of one folder |
| `POST /worktree/:id/folder` | `{ path }` | `{ path }`; creates the folder and any missing parents, and answers 409 if something is already there |
| `POST /worktree/:id/rename` | `{ from, to }` | `{ from, to }`; moves a file, folder or symlink, and answers 409 if `to` exists |
| `DELETE /worktree/:id/file` | `?path=` | 204; deletes a file, a symlink (the link, never its target) or a folder, recursively |

Besides `paths`, `symlinks` and `truncated`, the `files` answer carries
three more fields:

- `ignored: string[]` (see "Ignored files");
- `emptyDirs: string[]`;
- `status: Record<string, FileStatus>`, the git status colors (see "Git
  status").

A new file is `PUT /file` with `baseVersion: null` and empty content. It
needs no route of its own.

All seven routes work under both drivers, and all seven resolve only the
worktree's row, so each gets a row in `test/api/route-matrix.ts` answering
`MISSING` under both columns. The wire types go in
`@yaac/shared/types` next to `WorktreeChanges`.

### Domain: `packages/server/src/domain/worktrees/files.ts`

This module exports `listWorktreeFiles`, `listWorktreeDir`,
`readWorktreeFile`, `writeWorktreeFile`, `createWorktreeFolder`,
`renameWorktreeEntry` and `deleteWorktreeEntry` through the
`#domain/worktrees` barrel. Each one
resolves the worktree's record with `resolveWorktreeRecord` (a row is
enough, and a stopped worktree qualifies), confines the path, and does
plain `fs` I/O against `worktreeDir(slug, id)`. The git half of the
listing, `listCheckoutFiles(repoDir, worktreeId, worktreeDir)`, lives in
`#domain/git` beside `addWorktree`.

**Listing.** Every call names the git dir explicitly (Decision 4) and
passes `-c core.fsmonitor=false`, because the repo's config is not the
server's own. The server's existing git calls against the shared repo
already carry this exposure, so this adds no new surface. The calls run
concurrently:

1. `ls-files -z --cached --others --exclude-standard` gives the paths.
   `ls-files -z -d` gives the deleted ones, which are subtracted.
2. `ls-files -z --others --ignored --exclude-standard --directory` gives
   `ignored` (see "Ignored files").
3. `ls-files -z --others --exclude-standard --directory` gives each
   untracked directory as a single `dir/` entry, and **empty directories
   are among them** (checked). An entry with no path of call 1 under it is
   empty, and becomes `emptyDirs`. This is what makes "New folder"
   survive the next poll.
4. `status --porcelain=v1 -z --untracked-files=all` gives `status` (see
   "Git status").

The result is capped at 50,000 paths (`truncated`).

**Server-side git never writes.** A write to the worktree's `index` or the
shared `.git/config` from outside the pod is a lock the in-pod git can
collide with. It is also a replaced inode under the VM-side cache (the
`--no-track` note on `addWorktree`). `ls-files` never writes. `status`
normally refreshes and rewrites the index opportunistically, so it runs
with `--no-optional-locks`. Checked: without the flag, a status replaces
the index file (a new inode); with it, the file's inode and mtime are
untouched.

**Git status.** Call 4 of the listing maps to one `FileStatus` per
path:

- `modified` (`M`/`T` in either column);
- `added` (`A`, or the new path of an `R`/`C`);
- `untracked` (`??`);
- `conflicted` (`U` in either column, `AA`, `DD`).

Staged and unstaged changes are not told apart, as in VS Code's explorer.
Deleted files are not in the tree, so a `D` is dropped.

Two settings keep it cheap:

- `-c core.checkStat=minimal -c core.trustctime=false`. The index's stat
  data is written by in-pod git, and the server sees the same files
  through a different mount, where inode and device numbers need not
  match. Comparing only mtime and size keeps a clean file clean instead of
  forcing a re-hash of the whole tree on every poll.
- `--no-optional-locks` (above) means a refreshed index is never written
  back. So on a tree that is actually stale, each poll re-does the same
  work instead of saving it. That is acceptable at a 5-second poll that
  only runs while the explorer is on screen.

The colors mean "differs from HEAD", as in every editor. The Changes pane
shows the other question, what differs from the fork base.

**Create, rename, delete.** All three run under the per-worktree keyed
mutex and share one primitive: **resolving a path's parent directory to a
verified descriptor**. The walk runs one segment at a time from a
descriptor on the root:

1. Open each segment, following symlinks, through
   `/proc/self/fd/<parent>/<name>`.
2. Check where it landed (see Confinement).
3. Only then continue from that descriptor.

The final name is then acted on inside that pinned directory, so no
second path lookup is ever made. Checked: `rename` and `unlink` both work
through `/proc/self/fd/<dirfd>/<name>` paths, and an unlink of a symlink
removes the link and leaves its target alone.

- **Create file:** covered under Writes (`PUT /file`,
  `baseVersion: null`). A name containing `/` creates its parent folders,
  as in VS Code's inline input.
- **Create folder:** the same walk, running `mkdir` on each missing
  segment. It answers 409 if the final segment already exists.
- **Rename / move:** resolve both parents, refuse (409) if the destination
  name exists, then call `rename` between the two pinned directories. The
  existence check and the rename are two calls, so an agent creating the
  destination in between could be overwritten. That happens only inside
  the worktree, and only in a window of microseconds. `rename` never
  follows its last segment, so renaming a symlink renames the link. Moving
  a folder into its own subtree is refused before any call is made.
- **Delete:** resolve the parent, then act on the entry:
  - A file or symlink is unlinked in place.
  - A folder is removed with a descriptor-relative recursive delete. Open
    each child with `O_DIRECTORY | O_NOFOLLOW` through its parent's
    descriptor: a real folder is recursed into through that descriptor,
    and anything else (a file, or a symlink, which `O_NOFOLLOW` refuses) is
    unlinked by name. Node's own `fs.rm({ recursive })` is not used on
    k8s: it walks by path, so an agent swapping a subfolder for a symlink
    mid-walk could steer it into `server-local/`. The fd-relative walk
    cannot be steered, because it never re-resolves a path it has already
    checked. Under containerless, which has no sandbox to escape, it is
    plain `fs.rm`.
- None of the three touches git. A delete or rename of a tracked file
  shows up as a change in both the tree colors and the Changes pane, as it
  would after `rm`/`mv` in a terminal. The `.git` first-segment rule
  applies to both ends of a rename.

**Reads.**

- Open the file through the confinement check below.
- Refuse anything that `fstat` says is not a regular file.
- Return `content: null` over `MAX_EDITABLE_BYTES` (1 MiB, the build-files
  text cap).
- Otherwise read the bytes and compute the version. Treat the file as
  binary if there is a NUL in the first 8,000 bytes (git's heuristic) or if
  the bytes fail a strict UTF-8 `TextDecoder`. In either case `content` is
  `null`.
- `isBinaryFile` in `#domain/projects`' build files uses the same rule. Its
  `binary`/`MAX_TEXT_FILE_BYTES` pair can move to `#lib` and be shared, so
  the rule lives in one place.

**Writes.**

- Hold the per-file keyed mutex (`#lib/keyed-mutex`).
- Open the existing file with `O_WRONLY`, following symlinks, through the
  confinement check. Re-hash it through that same descriptor to compare
  with `baseVersion`.
- Then `ftruncate` and write **through that same descriptor**.
  - Saving a file that is a symlink updates the file it points to and
    leaves the link itself alone, which is what VS Code does too.
  - Writing in place keeps the file's mode (the executable bit), inode,
    hard links and ownership.
  - It also means there is no replaced inode for a cached dentry inside a
    gVisor pod to go stale on.
- A create (`baseVersion: null`) walks the parent directories one segment
  at a time, starting from a descriptor on the root:
  1. Open each existing segment with `O_DIRECTORY`, following symlinks,
     *relative to the previous segment's verified descriptor* (see
     Confinement), and verify where it landed before going on.
  2. `mkdir` any missing segment inside the verified descriptor.
  3. Create the file itself with `O_CREAT | O_EXCL | O_NOFOLLOW` inside the
     parent's verified descriptor.

  Nothing is created until the directory it goes in has been checked. A
  create whose final segment is a dangling symlink is refused: `O_EXCL`
  never creates through a link.

**Confinement.** Symlinks are followed, as long as where they finally lead
is inside the worktree. That covers the target of a symlinked file, every
symlinked directory segment on the way to it, and chains of links. This
is a security boundary: under k8s the checkout is controlled by the
sandboxed agent, and the server pod can see `server-local/`. A string
check on the path the user asked for proves nothing about where the kernel
ends up. A realpath-then-open sequence proves it only until the agent
swaps a directory for a symlink in between. So the check is made on what
was actually opened:

1. **Lexical check.** The path must be non-empty and relative, contain no
   NUL, and have no `..` segment after `path.posix.normalize`. A `.git`
   first segment is refused: nothing in the listing points there, and a
   write into it is how you would plant a hook or config. A symlink can
   still lead *into* `.git/`. The descriptor check refuses that too,
   because it tests where the file actually is.
2. **Open, following links, then verify the descriptor.** Read back where
   the descriptor really landed with `readlink('/proc/self/fd/<fd>')`, and
   require it to be `realpath(worktreeDir)` or sit under it. A root under a
   symlinked path, like macOS's `/var` → `/private/var`, compares
   correctly because both sides are real paths. Otherwise, close the
   descriptor and refuse with 400 "points outside the worktree", which is
   a distinct message from a missing file's 404. All I/O goes through the
   verified descriptor, so there is no second lookup that could be raced.
3. **Relative opens pin the directory.** A create's segment-by-segment
   walk opens each name through the parent's `/proc/self/fd/<dirfd>/<name>`.
   That path resolves from the already-open, already-verified directory,
   not by walking the path again. So a directory swapped for a symlink
   after its check cannot redirect the next step. Node has no `openat`,
   and this Linux idiom stands in for it.
4. **Containerless** has no sandbox to escape. The agent already runs as
   the host user, and the server may be a macOS process with no
   `/proc/self/fd`. There, steps 2 and 3 fall back to comparing
   `fs.realpath` of the target against the root, where a race costs
   nothing the agent couldn't do directly. The branch is on whether
   `/proc/self/fd` exists, and it lives in the helper, not on the driver
   kind.

**Absolute symlinks** resolve as the server sees them:

- Under containerless, they are host paths, and they work if they land in
  the worktree.
- Under k8s, a link written in-pod as `/workspace/src/x` means nothing in
  the server pod. The server mounts the checkout elsewhere, so such a link
  reads as broken. Relative links, which are what git checks out and what
  most tools create, work everywhere.
- Rewriting `/workspace/...` targets onto `worktreeDir` would mean resolving
  links by hand instead of letting the kernel do it, and that brings back
  exactly the race the descriptor check closes. It is not done.

**Symlinks in the listing.** `git ls-files` reports a symlink as a single
entry, and never lists what sits behind a symlinked directory. So the
listing `lstat`s each path it returns, which is about 50 ms for 50k paths,
and answers `symlinks: Record<path, { target: string | null, dir: boolean }>`.
`target` is the link's resolved path relative to the worktree, and `null`
when it leads outside or is broken. The explorer then:

- shows a link glyph on every symlink, and greys out ones whose `target` is
  `null` ("points outside the worktree" / "broken link"), which don't open;
- expands an in-worktree directory link by re-rooting the listing's paths
  under its target. `lib → src/lib` shows `src/lib/*` as `lib/*`, with no
  second listing route. Opening `lib/a.ts` sends that path, and the server
  follows the link to it;
- expands lazily, so a link to an ancestor is simply expandable forever,
  as it is in VS Code, rather than a loop;
- has the filter and quick-open search only the real paths, never the
  paths as seen through a link, which avoids both duplicates and cycles;
- expands a directory link into an ignored folder
  (`vendor → node_modules/x`) through the `dir` route, exactly like an
  ignored folder itself.

**Ignored files.** The listing gets them from a third, cheap git call:

```
git ... ls-files -z --others --ignored --exclude-standard --directory
```

`--directory` collapses each wholly ignored folder into a single entry
with a trailing `/`, so `node_modules/` costs one line rather than its
hundred thousand files. Individually ignored files (`debug.log`, `.env`)
come back as themselves. The answer is `ignored: string[]`, and the git
call is checked against a checkout holding all three kinds.

It is returned on every listing, so the toggle is purely client-side and
needs no refetch. Contents are fetched only when someone expands an
ignored folder, through `listWorktreeDir`:

- It opens the folder with `O_DIRECTORY` through the same descriptor
  check, then runs `readdir` on `/proc/self/fd/<fd>` (or on the
  realpath'd directory under containerless).
- It `lstat`s each entry for `dir` and `symlink`.
- It caps the result at 5,000 entries (`truncated`).
- Everything under an ignored folder is ignored, so a readdir that ignores
  `.gitignore` is the correct answer there. A negated pattern re-including
  a file deep inside an ignored folder is the one case where it shows
  slightly more than git would. That is harmless, because it only happens
  once the user has asked to see ignored files.

The confinement helper is internal, so it gets no `describe` of its own
and is covered through `readWorktreeFile` and `writeWorktreeFile` (see
Testing).

## Frontend

### Targets and helpers: `#lib/files.ts` (new; the client also goes here)

This mirrors `changesApi.ts` and `preview.ts`:

- constants and helpers: `FILES_TARGET = 'files'`, `fileTarget(path)`,
  `isFileTarget(t)`, `fileTargetPath(t)`, `isFilesTarget(t)`;
- the API client: `listWorktreeFiles`, `readWorktreeFile`,
  `saveWorktreeFile`, which surfaces a 409 as a typed `FileConflict`;
- `buildTree(paths)`, which turns the flat list into a folder/file tree
  sorted folders first, then by name;
- `fileTabLabels(paths)`, which gives each open file its basename, plus
  just enough of its parent path to tell apart two open `index.ts` files
  (the VS Code rule);
- `placeFile(ws, target)`, which decides where a newly opened file lands.
  If it is already open, the answer is unchanged. Otherwise it becomes a
  tab of the column holding the active file pane, then of any column
  holding a file pane. Failing both, it becomes a new column immediately
  right of the explorer, and failing that a new column at the end. This is
  VS Code's "open in the active editor group". It is built from
  `addTab`/`addColumn`/`moveTargetToColumn`, so `layout.ts` needs no new
  primitive.

### Store (`store.ts`)

- `openFiles(worktreeId)`: opens the explorer. It is a copy of
  `openChanges` using `injectPaneLeaf(base, FILES_TARGET)`.
- `openFile(worktreeId, path)`: `placeFile`, then activate and focus.
- `dirtyFiles: Record<string, true>`, keyed by `${worktreeId}|${path}`.
  Each editor pane sets or clears its own entry. The tab strip reads it for
  the dirty dot, and the close path reads it for the confirm dialog.
- The explorer's view state (expanded folders, filter text, scroll, show
  ignored) follows the Changes pane's pattern. The cleaner way to do it is
  a refactor taken in the same change: fold
  `changesExpanded`/`changesScroll`/`changesFind` into one
  `paneView: Record<paneKey, { expanded?, scroll?, find?, showIgnored? }>`
  and move both panes onto it. That adds one field for the second pane
  instead of four. `changesFindPending: boolean` becomes
  `findPending: string | null`, naming the pane (`changes` or `files`)
  whose filter box should take focus once mounted. The one mechanism then
  serves both find-changes and `open-files`.

### Explorer pane: `components/WorktreeFiles.tsx`

- It has a header strip in the same style as Changes (`h-7`, hairline
  border): a file count, a "truncated" note when truncated, and a filter
  input.
- Its body is a tree of folders (chevrons) and files (the Changes pane's
  two-tone `PathLabel`, moved to `ui/` so both panes share it). Clicking a
  file calls `openFile`. With a filter active, the body becomes a flat list
  of paths matching it as a case-insensitive subsequence, best matches
  first, capped at 200, where Enter opens the top hit. That makes the
  filter box the quick-open.
- **Show ignored.** A toggle in the header (an eye icon), per worktree in
  the pane's `paneView` state. When on, the tree merges `ignored` into the
  listing:
  - Ignored entries render dimmed, as they do in VS Code.
  - An ignored folder expands through
    `useQuery(['dir', worktreeId, path])`, fetched on first expand and
    refetched with the listing.
  - A `truncated` folder ends with a "first 5,000 shown" row.
  - The filter and quick-open search the ignored *files* in the listing,
    but never walk into ignored folders. Searching `node_modules` would
    make quick-open useless and would mean a recursive walk the server
    doesn't do.
  - When off, ignored paths are dropped and nothing is fetched.
- **Git status colors.** A file's name is tinted by its `status`, and a
  single-letter badge sits at the right edge of its row. The palette is the
  Changes pane's `STATUS_META`, lifted into `#lib/gitStatus` so both panes
  share it:
  - M: yellow;
  - A/U: green (U is untracked);
  - `!`: red, for conflicted.

  A folder takes the strongest status among its descendants, shown as the
  tint and a dot rather than a letter. The order is conflicted > modified
  > added/untracked. Ignored entries are dimmed and carry no status. The
  filter's flat result list shows the same colors.
- **Create, rename, delete.** These follow the VS Code interaction model:
  - **Header buttons** for New file and New folder create in the selected
    folder, or at the root. They open an **inline input row** in the tree
    at that spot. Enter commits, Escape cancels, and a name containing `/`
    creates the folders along the way. A new file opens in an editor pane
    once it is created.
  - **A context menu on every row** (Base UI's `ContextMenu`, which
    `@base-ui/react` already ships) offers New file / New folder (on
    folders), Rename and Delete. A hover `⋯` button opens the same menu for
    touch and for mouse users who don't right-click.
  - **No keyboard shortcuts in the tree.** Rename and delete are reached
    only through the menu. Rename reuses the inline input, pre-filled,
    with the name selected up to the extension.
  - **Delete confirms** through `ConfirmDialog`. A folder's confirm counts
    what it holds from the listing ("Delete `src/old` and its 14 files?").
    Deleting a symlink says that it removes the link only.
  - Each action invalidates the `files` query, so the tree shows its
    result at once instead of at the next poll. Just-created empty folders
    appear through `emptyDirs`.
  - Errors (409, or "points outside the worktree") show inline under the
    input row. A failed rename keeps the input open.
- **Open editors follow.**
  - A rename of a file or folder rewrites every `file:<path>` target under
    it through a new pure `renameTargets(ws, from, to)` in `#lib/layout`,
    and moves the matching `dirtyFiles` keys.
    - A rename first flushes every affected pane, and runs once those
      saves land.
    - If a flush cannot land (a paused conflict, or a failing save), the
      rename is refused with "resolve unsaved changes first", because the
      pane's mount key changes and would drop the buffer.
  - A delete cancels the affected panes' pending autosaves before it runs,
    so a timer cannot recreate what was just deleted, and then closes those
    panes. If any hold unsaved text, the delete's confirm lists them.
- It fetches with `useQuery(['files', worktreeId])` and a
  `refetchInterval` of 5 seconds. It is **ephemeral** like Changes:
  unmounted when off-screen, so a hidden explorer runs no listing.
- Its states (loading, and error with Retry) reuse the Changes markup. A
  stopped worktree browses like a running one.

### Editor pane: `components/WorktreeFile.tsx`

- A header strip shows the path (faint directory, bright basename), a
  dirty dot, a save state ("Saving…" / "Saved" / "Save failed, retrying" /
  "Paused: conflict"), and a Save button.
- The body is CodeMirror at full height, with `basicSetup` (line numbers,
  history, in-file search, bracket matching) and the language from
  `languageForPath`. These are the editor's own standard text-editing keys
  (undo, find in file, and so on). The pane adds no key bindings of its
  own: saving is the app-level shortcut below.
- It is **kept mounted** while hidden, like chat and terminal panes rather
  than like Changes. Unmounting would throw away the undo history, cursor,
  scroll and unsaved text, and a mounted CodeMirror costs little. Polling
  runs only while the pane is visible (`enabled: visible`), with an
  immediate refetch whenever it becomes visible again.
- It polls the read route with `known` every 2 seconds while visible. When
  the version changes:
  - A **clean** buffer takes the new text as one minimal change (common
    prefix and suffix trimmed, so the cursor and scroll survive). It does
    not go through `@uiw/react-codemirror`'s `value` prop, which would
    replace the whole document.
  - A **dirty** buffer keeps the user's text and shows a banner: "Changed
    on disk since you started editing: **Reload** (discard yours) ·
    **Overwrite**". Overwrite saves against the new version.
  - A save that comes back 409 shows the same banner.
- **Saving.** One `useSaver` hook per pane owns every write:
  - **Debounce:** each edit restarts a 1 s timer, and its expiry saves.
  - **Flush now:** Cmd/Ctrl-S (see "Shortcuts"), the Save button, the
    pane going hidden or losing focus (VS Code's `onFocusChange`), and the
    start of a close or a rename all cancel the timer and save
    immediately.
  - **One in flight.** A save sends the buffer and the version it was
    loaded or last saved at. Edits made while it is in flight schedule
    another save, which runs after it lands and uses the version that save
    returned. So saves never race each other, and the pane's own writes
    never 409 against themselves.
  - **Polls issued before the latest save landed are ignored.** They carry
    a sequence number, so a stale answer cannot make the pane's own write
    look like a change on disk.
  - **A 409 pauses autosave** for that pane and shows the conflict banner.
    Autosave never overwrites the agent's version. It resumes only once
    the user picks **Reload** or **Overwrite** (an explicit save against
    the new version). The same applies when the file is gone: the server
    answers 409 with no version for a non-null `baseVersion` against a
    missing file. So autosave can never bring back a file the agent (or a
    tree delete) removed. Only "Save to recreate" can.
  - **A transport failure** (network, 500) keeps the buffer dirty and
    retries after 2, 5 and then 10 s. The Save button retries at once.
  - **Dirty** means "the text differs from what the last successful save or
    load holds". With autosave the dot is usually a second-long blink,
    as it is in VS Code.
  - Saving a partly typed line can briefly break a watcher's build (vite,
    tsc --watch). That is inherent to autosave, and the 1 s idle is what
    keeps it rare.
- It shows terminal states in place of the editor:
  - binary: "Binary file, not shown";
  - over the cap: "Too large to edit (N MB)";
  - `missing`: "Deleted on disk", with Close. If the buffer is dirty, it
    also offers "Save to recreate", sent with `baseVersion: null`.
- A `beforeunload` guard runs while any `dirtyFiles` entry exists or a
  save is in flight. With autosave that is only the last second of typing,
  a paused conflict, or a failing save.

### Wiring (`WorktreeView.tsx`, `panes.ts`, mobile)

- `isSpecialPane`: add `isFilesTarget || isFileTarget`, which keeps them
  out of the tmux-window sync.
- `paneStillLive`: both targets answer `true`, because they belong to the
  user, like preview and changes.
- `paneName`: `'Files'` for the explorer, `fileTabLabels` for editors.
- Mounting branch: the explorer is ephemeral like `changes`. File panes
  are non-ephemeral like `chat`, which takes one extra term in the existing
  `ephemeral` expression.
- Close (both the tab × and Alt-W): no kill-confirm. A file pane first
  flushes and closes once that save lands. Only a flush that cannot land
  (a paused conflict, or a failing save) shows `ConfirmDialog` ("Discard
  unsaved changes to X?"). Closing clears the pane's `dirtyFiles` entry. The tab shows a dot instead of the × while
  the file is dirty.
- Header: a Files button beside Changes (a `lucide` folder-tree icon,
  added through `#lib/icons`). On mobile it goes in the `⋯` menu next to
  Changes (`docs/mobile-layout.md`). Forced tabs mode already makes the
  rest work.
- **`open-files` on Alt-E** opens or surfaces the explorer (see
  "Shortcuts"). The header button and the mobile `⋯` menu open it too.
- Changes pane: an "Open file" icon on each accordion header that calls
  `openFile(path)`. It is hidden for deleted files. This is the cheapest
  path from reviewing a change to fixing it.

### Shortcuts

This plan adds two keys. Only one of them is a rebindable app shortcut.
The tree has no keys of its own, and the editor otherwise has only
CodeMirror's standard editing keys.

**`open-files`**

- **Registry entry:**

  ```ts
  { id: 'open-files', label: 'Open file tree',
    description: 'Open the file tree and focus its filter.',
    defaultChord: alt('KeyE') }
  ```

  Alt-E is free, and it is the same letter as VS Code's Explorer.
- **Handler:** a case in `WorktreeView`'s window keydown listener, beside
  `find-changes` and shaped like it. It calls `preventDefault` and
  `stopPropagation`, then `openFiles(sid)`, then
  `setFindPending('files')`. The mounted explorer consumes the flag by
  focusing and selecting its filter box. So Alt-E, then typing, then Enter
  is quick-open.
- On macOS, Option-E is a dead key (it types the accent in `é`), so this
  shortcut takes it over everywhere in the app. That is the same trade
  every existing Alt-letter default already makes, and a rebind gives it
  back.

**Cmd/Ctrl-S: fixed, not in the registry**

Save is not in `SHORTCUTS`. It does not appear in Settings → Shortcuts and
cannot be rebound. Like undo, it is part of what an editor is, not an app
command.

- **Handler:** an `onKeyDown` on the file pane's root element, so it covers
  the editor and the pane's header strip (a focused Save button, the
  banner). It fires on `Cmd-S` on macOS and `Ctrl-S` elsewhere, with no
  other modifier. It calls `preventDefault`, which suppresses the browser's
  "Save page", and flushes the pane's `useSaver`. It is not a CodeMirror
  `Mod-s` keymap entry, which would only fire while the text had focus.
- **Scoped by construction.** The handler lives on the file pane, so
  Ctrl-S in a terminal pane never reaches it and still reaches the shell
  (readline's forward search, emacs, XOFF). Cmd-S anywhere else keeps its
  browser meaning. No store nonce is needed, because the pane handles its
  own key.
- **Reserved in the registry.** `WorktreeView`'s window listener runs in
  the capture phase, ahead of the pane. So a user who bound some command to
  Ctrl-S would swallow saving. `validateChord` therefore refuses the
  platform's save chord with "Reserved for saving files". That is one more
  check beside the existing bare-modifier and duplicate checks.
  `mergeBindings` likewise drops a stored override that names it, so a
  hand-edited preferences file cannot take it either.
- **One platform check.** Both the handler and the reservation need "is
  this macOS". `IS_MAC` is defined twice today, identically in
  `SettingsButton` and `WorktreeTerminal`, and `WindowControls` has a third
  variant. They collapse into one `IS_MAC` export in `#lib/platform`.

### Consolidation taken as part of this change

- **One language table.** `#lib/highlight` gains
  `editorLanguage(lang): Language`, returning the Lezer language or
  `StreamLanguage.define(mode)`. `buildParser` becomes
  `editorLanguage(lang).parser`. `ui/CodeEditor` takes
  `HighlightLanguage | null` instead of its own
  `'json' | 'dockerfile' | 'text'`, and `BuildFiles`' private `languageFor`
  is deleted in favor of `languageForPath`. The settings editors gain every
  language for free.
- **Theme-aware editor.** `CodeEditor` hard-codes `theme="dark"`. Switch it
  to `classHighlighter` plus an `EditorView.theme` built on the app's CSS
  variables, with the `tok-*` colors that `index.css` already defines for
  `.diff-hl` lifted to a shared selector. The editor, the diff and the
  settings editors then match in both light and dark themes.
- **Pane view state.** The `paneView` fold described under Store.
- **One `IS_MAC`.** The three platform checks collapse into `#lib/platform`
  (see "Shortcuts").

## Testing

**Server unit tests** (`packages/server/test/domain/worktrees/files.test.ts`,
one `describe` per barrel function):

- These run against a real temp checkout (`testTmpBase()`) made by
  `addWorktree`, with its `.git` file then rewritten to a nonexistent
  `/repo/...` path. That is exactly the shape the server sees under k8s.
  Nothing is mocked but the record lookup.
- `listWorktreeFiles`: untracked and gitignored files, removing deleted
  paths, the cap and `truncated`.
- `readWorktreeFile`: lexical rejection (absolute, `..`, NUL, `.git/`),
  missing mapping to 404, `known` short-circuiting, binary detection (NUL
  and invalid UTF-8), and the size cap.
  - **Followed:** a file link, a directory-segment link, and a two-hop
    chain, all landing inside the worktree.
  - **Refused with 400:** a link to `../../..`, an absolute link outside
    the checkout, a link into `.git/`, and an in-worktree directory link
    whose *target* holds a link that leads out.
- `writeWorktreeFile`:
  - a conflict mapping to 409 with the current version, a create
    conflicting with an existing file, and a save against a deleted file
    answering 409 with `version: null`, with nothing created;
  - the mode and inode preserved on an executable file;
  - a save through an in-worktree symlink updating the target and leaving
    the link alone;
  - a save through an escaping link refused, with the outside file
    byte-for-byte unchanged;
  - a create under an in-worktree symlinked parent landing in its target;
  - a create under an escaping parent refused, with nothing created
    outside the checkout;
  - a create at a dangling link refused.
- `listWorktreeFiles`: `symlinks` entries for in-worktree, escaping and
  broken links; `ignored` holding a collapsed `node_modules/`, a
  collapsed nested ignored folder, and an individually ignored file.
- `listWorktreeFiles` status: modified, staged-new, untracked (including
  inside a new folder, `-uall`), a rename's new path, conflicted, and a
  deletion dropped. After a clean status call, the worktree's `index`
  keeps its inode and mtime (the no-write rule). `emptyDirs` holds an empty
  folder and a nested empty folder, but not an untracked non-empty one.
- `createWorktreeFolder`: nested creation, 409 on an existing entry, a
  create under an in-worktree symlinked parent landing in the target, and
  one under an escaping parent refused with nothing created outside.
- `renameWorktreeEntry`: a file, a folder, a move across folders, a
  symlink renamed as the link, 409 on an existing destination, a move into
  its own subtree refused, `.git` at either end refused, and an escaping
  destination parent refused.
- `deleteWorktreeEntry`:
  - a file;
  - a symlink, removed as the link with the outside target intact;
  - a folder, recursively;
  - a folder holding a symlink to an outside folder, where the link goes
    and the outside folder is byte-for-byte intact;
  - an escaping parent refused.
- `listWorktreeDir`:
  - an ignored folder's children, with `dir`/`symlink`;
  - the cap and `truncated`;
  - a directory link inside the worktree followed;
  - one that escapes refused with 400;
  - a path that is a file rather than a folder refused.

**Containerless e2e** (`test/e2e-containerless`, which runs in a dev
worktree, added to `worktree-suite` so it reuses that file's worktree): a
round trip over HTTP (create, list, read, save against a stale version and
get 409, then save), expanding `node_modules/` through `dir`, and reading
the same file after the worktree stops.

**k8s e2e** (`test/e2e`, host-only). This tier also checks that status on
an unchanged tree reports it clean (no stat-data mismatch across the two
mounts). It is the tier that proves what the
unit tests cannot: a server write is visible to the gVisor pod
immediately. Save through the route, then `cat` the file from inside the
pod on the shared worktree fixture. In the other direction, edit from the
pod and check that the next read returns the new version.

**API matrix:** seven rows, identical under both drivers.

**Frontend unit tests** (`packages/frontend/test/`):

- `files.test.ts` for `buildTree` (including folder status rollup),
  `fileTabLabels` and `placeFile`,
  covering the placement order and the no-op when the file is already open.
- `worktree-file.test.tsx` (fake timers, API mocked at `fetch`):
  - a clean buffer reloading on a version change, and the dirty banner;
  - **autosave:**
    - no save before 1 s idle, and exactly one after a burst of edits;
    - Cmd/Ctrl-S and hiding the pane both flushing at once;
    - edits during an in-flight save coalescing into one follow-up save
      with the returned version;
    - a stale poll ignored;
    - a 409 pausing autosave until Reload/Overwrite;
    - a deleted file never recreated by the timer;
    - retry backoff after a 500;
    - close flushing, and confirming only on a paused conflict.
- The existing `highlight.test.ts` and `file-editor.test.tsx` updated for
  the single language table.
- `shortcuts.test.ts`:
  - the `open-files` default Alt-E, and a stored override replacing it;
  - `validateChord` refusing the platform's save chord (Cmd-S on macOS,
    Ctrl-S elsewhere) while accepting the other platform's;
  - `mergeBindings` dropping an override that names the save chord;
  - no registry entry for save.
- The `WorktreeView` shortcut tests:
  - Alt-E opening the explorer (or surfacing it when already open) and
    setting `findPending` to `files`, and the explorer's filter box taking
    focus once mounted;
  - a rebound Alt-E working, and the old chord no longer doing anything.
- `worktree-file.test.tsx`:
  - Cmd/Ctrl-S flushing with `preventDefault`, from both the editor and
    the focused Save button;
  - the key ignored with Shift or Alt held.

**Playwright** (`test-playwright-scripts/file-editor.js`):

- Press Alt-E, type part of a file name, and press Enter to open it. Then
  open a second file side by side from the tree, and edit one.
  Watch the dirty dot clear by itself about 1 s later, and check the bytes
  on disk. Then edit again and save at once with Cmd-S. Press Ctrl-S in a
  terminal pane and check that it reaches the shell. Check that Settings →
  Shortcuts lists "Open file tree" but no save entry.
- Have the agent's shell `echo >>` the other file and watch the clean
  buffer reload in place.
- Edit the first file again, then change it from the shell, and check that
  the conflict banner appears.
- Turn on "show ignored", expand `node_modules/`, and open a file inside
  it.
- Create `a/b/new.ts` from the header button and watch it open, rename it
  from the context menu and watch its open pane follow, then delete its folder from the
  context menu and confirm. Check the tree colors along the way: green for
  untracked, yellow after editing a tracked file.

## Scope

This plan is the whole of the work:

- the explorer pane, with a filter that doubles as quick-open, a "show
  ignored" toggle, git status colors, and create/rename/delete of files and
  folders;
- editor panes that follow symlinks within the worktree;
- debounced autosave plus explicit save, with conflict detection;
- the Changes → open-file link;
- the consolidation above.

**Out of scope:** preview tabs (every click in the tree opens, or focuses,
a regular tab), per-column widths, LSP (completions,
diagnostics), multi-cursor collaboration, and search across files (the
terminal has `rg`).
