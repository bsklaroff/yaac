# File editor

The webapp browses and edits a worktree's files in two kinds of pane that sit
in the ordinary layout, next to terminals and Changes:

- **`files`** — the explorer, one per worktree: a tree, a filter that doubles
  as quick-open, a "show ignored" toggle, git status colors, and create /
  rename / delete.
- **`file:<path>`** — one editor pane per open file (`<path>` relative to the
  worktree root). Because each is a plain layout leaf, side-by-side files,
  tabs, drag, Alt-W, tab cycling and persistence across reloads come from the
  layout rather than from a second tab system inside a pane.

Columns stay equal-width: an explorer column takes a full share, and the
filter box (quick-open) covers tabs mode and phones.

## Server

### I/O on the server's own filesystem

`#domain/worktrees` (`files.ts`) reads and writes the checkout with plain
`fs` against `worktreeDir(slug, id)`. That path is GLOBAL-tier, mounted by the
server pod under k8s, and it is the host checkout itself under containerless,
so there is no driver verb and no in-workspace script, and both drivers answer
identically. Every route resolves the worktree's **record**
(`resolveWorktreeRecord`), so a stopped worktree browses and edits like a
running one — its checkout stays on disk (docs/worktree-storage.md).

Ownership needs nothing: the server already runs as the worktree's user. On
k8s the server Deployment, every worktree pod and the proxy share
`hostUidSecurityContext()`; macOS virtiofs writes as the host user anyway;
under containerless they are the same process user.

The cost is coupling to where the checkout lives: node-local checkouts
(docs/plans/cloud-k8s.md, step 9) would need an in-pod path for the editor.

| Route | Answer |
|---|---|
| `GET /worktree/:id/files` | `WorktreeFiles`: `paths`, `symlinks`, `ignored`, `emptyDirs`, `status`, `truncated` |
| `GET /worktree/:id/dir?path=` | the immediate children of one folder (capped at 5,000) |
| `GET /worktree/:id/file?path=&known=` | `{ path, version, size, binary, content? }` |
| `PUT /worktree/:id/file` | `{ path, content, baseVersion }` → `{ path, version, size }`, or 409 |
| `POST /worktree/:id/folder` | creates a folder and its missing parents; 409 if taken |
| `POST /worktree/:id/rename` | moves a file, folder or symlink; 409 if the destination exists |
| `DELETE /worktree/:id/file?path=` | deletes a file, a link (never its target) or a folder, recursively |

### Listing

`listCheckoutFiles` in `#domain/git` runs git on a `worktree` target
(docs/server-git.md), which names the admin dir, the shared repo and the work
tree explicitly. It has to: the in-pod setup rewrites the checkout's `.git`
file to the container's own view (`/repo/...`), which means nothing to the
server. The runner also keeps git off the agent-writable repo config, so no
filter, fsmonitor or hook it names runs here. Four read-only calls run
concurrently:

1. `ls-files --cached --others --exclude-standard`, minus `ls-files --deleted`
   — the paths, gitignore-aware with no JS reimplementation.
2. `ls-files --others --ignored --exclude-standard --directory` — `ignored`,
   where `--directory` collapses a wholly ignored folder (`node_modules/`) to
   one entry.
3. `ls-files --others --exclude-standard --directory` — the untracked folders.
   git records no folder, so each of these is walked (through pinned
   descriptors, never following a link, skipping ignored folders) for the
   folders holding no listed file: `emptyDirs`, which is what makes "New
   folder" survive the next poll.
4. `status --porcelain=v1 -z --untracked-files=all --ignore-submodules=all`
   (never entering a submodule's pod-written git dir) — `status`, one
   `FileStatus` per path (`modified`, `added` including a rename's new path,
   `untracked`, `conflicted`; a deletion is dropped). The colors mean
   "differs from HEAD"; Changes answers "differs from the fork base".

**Server-side git never writes.** A write to the worktree's index from outside
the pod is a lock in-pod git can collide with, and a replaced inode under the
VM's cached view (see `addWorktree`'s `--no-track` note). `ls-files` never
writes; `status` runs with `--no-optional-locks` so its opportunistic index
refresh is never written back, and with `core.checkStat=minimal` /
`core.trustctime=false` so stat data written by in-pod git through another
mount does not make every file look dirty.

The listing is capped at 50,000 paths (`truncated`). git reports a symlink as
one entry, so each path is `lstat`ed and links answer `{ target, dir }`, the
target relative to the worktree or null when broken or outside.

### Confinement

Under k8s the checkout is the sandboxed agent's to shape and the server pod
can see `server-local/`, so every path is a security boundary. Links are
followed — file links, linked folders along the way, chains — as long as
where they finally land is inside the worktree (its `.git` counts as
outside), and that is checked on **what was opened**, not on a string:

1. **Lexically**: non-empty, relative, no NUL, no `..` once normalized, not
   under `.git` (a write there is how a hook gets planted).
2. **Open, then verify the descriptor**: `readlink('/proc/self/fd/<fd>')` must
   be `realpath(worktreeDir)` or under it; otherwise 400 "points outside the
   worktree". All I/O then goes through that descriptor, so no second lookup
   can be raced. Opens are non-blocking so a planted FIFO cannot hang one.
3. **Walks pin each directory**: create, mkdir, rename and delete resolve a
   path's parent one segment at a time, opening each through the previous
   segment's verified descriptor (`/proc/self/fd/<fd>/<name>`, Linux's
   stand-in for `openat`), and act on the final name inside the pinned
   directory.
4. **Without `/proc/self/fd`** (a macOS containerless server) the same checks
   run on `fs.realpath`: there is no sandbox to escape, and a race costs
   nothing the agent could not do directly. The branch is on `/proc`, not on
   the driver kind.

A recursive delete opens each child as a folder through its parent's
descriptor and verifies it landed exactly there — `O_NOFOLLOW` alone is not
enough, since gVisor follows a link when `O_DIRECTORY` is also set — and
unlinks anything else by name. Node's `fs.rm({ recursive })` walks by path,
so a folder swapped for a link mid-walk could steer it out of the checkout.

An absolute link resolves as the server sees it: a link written in a pod as
`/workspace/x` reads as broken from the server. Rewriting such targets would
mean resolving links by hand, which reopens the race the descriptor check
closes.

### Reads, writes and versions

A file's **version** is the sha256 of its bytes. A read refuses anything
`fstat` calls irregular, answers `content: null` for a binary file (a NUL in
the first 8,000 bytes, or invalid UTF-8 — the rule `#lib/text-file` shares
with the build-files editor) or one over 1 MiB, and omits `content` when the
caller's `known` version is still current.

A save names the version it was made against. Under a per-worktree mutex the
server re-reads and re-hashes the file through the descriptor it will write,
and refuses a mismatch with 409 `{ version }` — the one error body carrying
more than a code, because the editor saves against it next. It then truncates
and writes **through that descriptor**: the file keeps its mode, inode, links
and owner, no inode is replaced under a gVisor pod's cached dentry, and saving
through a link updates its target. A non-null `baseVersion` against a missing
file is a 409 with `version: null` — a save never creates, which is what stops
autosave from resurrecting a deleted file. `baseVersion: null` creates, with
`O_CREAT | O_EXCL | O_NOFOLLOW` inside the pinned parent (making missing
folders on the way), and never through a link, dangling or not.

Create, rename and delete touch no git: a rename or delete of a tracked file
shows up in the colors and in Changes, as `mv`/`rm` in a terminal would.

## Webapp

`#lib/files` holds the targets, the API client, and the pure helpers:
`buildTree` (the tree, with folder status rolled up strongest-first),
`filterPaths` (case-insensitive subsequence, best first, capped at 200),
`fileTabLabels` (a basename, plus just enough parent path to tell two
`index.ts` apart) and `placeFile` (VS Code's "open in the active editor
group": a tab of the column holding the active file pane, then of any column
holding one, else a new column right of the explorer, else at the end).
`renameTargets` in `#lib/layout` moves every `file:` target under a renamed
path.

### Explorer (`WorktreeFiles`)

Ephemeral like Changes: torn down off-screen, so a hidden explorer runs no
listing; while visible it refetches every 5 seconds. Its view state
(expanded folders, scroll, filter, show-ignored) lives in the store's
`paneView`, which Changes shares.

- Only rows under expanded folders render, so a large repo with folders
  collapsed is a handful of nodes and needs no virtualization. Open folders
  draw an indent guide, files take an icon and tint by kind (from
  `languageForPath`), and the header's collapse-all empties `expanded`.
- **Quick-open** replaces the tree while the filter has text: each result
  reads basename first, folder after, and the arrow keys move a highlighted
  result that Enter opens.
- **Links** show a glyph; a broken or escaping one is dimmed and does not
  open. A folder link expands by re-rooting the listing under its target
  (`lib → src/lib` shows `src/lib/*` as `lib/*`), lazily, so a link to an
  ancestor is expandable rather than a loop. Opening `lib/a.ts` sends that
  path and the server follows the link. The filter searches only real paths.
- **Ignored files** come with every listing, so the toggle refetches nothing.
  They render dimmed; a wholly ignored folder's children come from the
  folder route on first expand. The filter searches ignored *files* but
  never walks into ignored folders.
- **Create / rename / delete** go through an inline input (a name with `/`
  makes the folders along the way) opened from the header buttons or from a
  row's menu — right-click, or the hover `⋯` for touch. The tree itself has
  no key bindings. A rename first lands every affected pane's unsaved text (a
  pane remounts under its new path) and is refused with "resolve unsaved
  changes first" if that cannot land. A delete cancels affected autosaves,
  confirms (counting a folder's files, noting a link is removed alone,
  listing unsaved panes), and closes those panes.

### Editor pane (`WorktreeFile`)

CodeMirror through `ui/CodeEditor`, with the language from the one table in
`#lib/highlight` (`languageForPath` → `editorLanguage`, which the diff view
parses with too) and a theme built on the app's CSS variables, whose `tok-*`
colors the diff shares — so the editors, the settings editors and the diff
match in both themes. Long lines wrap. Kept mounted while hidden, like a
terminal: unmounting would drop undo history, cursor and unsaved text.

- **Text size** is one store value (`editorFontSize`, default 12px,
  persisted in localStorage) that every file pane shares. It is set the way
  editors set it — Cmd/Ctrl =/−/0 while focus is in the pane, matched on the
  character so the keys labelled +/− work on any layout, which then size the
  text instead of zooming the page — or from the header's one "Aa"
  button, a reader-app style − / size / + / Reset popover. Below the mobile
  breakpoint index.css pins editor text at 16px (iOS zooms on focus into
  anything smaller), so the button is hidden there.
- **Find** is `ui/FindPanel`, CodeMirror's search panel redrawn as a small
  React root: the query with a live "3 of 12" count inside it (as a
  browser's find bar has it) and case / whole-word / regex toggles, previous /
  next, and a replace row behind a chevron. The two rows share one grid, so
  the fields line up and each row's buttons sit against its field; every
  control has a tooltip saying what it does and its key.
  Typing jumps to the first match from the cursor; Enter / Shift+Enter step,
  Escape closes back into the editor without reaching `document` (a dialog
  around a settings editor would close with it). Every `CodeEditor` gets it,
  the settings editors included.
- **The count never runs on the main thread.** Counting a 1 MiB file takes
  ~0.1 s, and a regex that backtracks can take forever — a `RegExp.exec`
  cannot be interrupted. So `MatchCounter` (`#lib/matchCount`) counts in a
  Worker, debounced after typing and edits, and terminates it when a newer
  count supersedes it or it runs past 1.5 s; the typing jump reads the
  worker's matches. A regex goes one step further: CodeMirror's highlighter
  and next / previous run it on the main thread, so a typed regex reaches
  the editor's search state only once the worker has counted it in time.
  One that times out stays in the bar as "Too slow to count".

- **Polling** runs only while visible, every 2 seconds and at once on
  becoming visible, sending `known`. A clean buffer takes a new version as one
  minimal change (common prefix and suffix trimmed), so the cursor survives; a
  dirty one keeps the user's text under a "Changed on disk: Reload ·
  Overwrite" banner.
- **Saving** is one path with two triggers: 1 second after the last edit, or
  at once on Cmd/Ctrl-S, the Save button (shown only while the buffer is
  dirty), the pane hiding or losing focus,
  and the start of a close or rename. One save runs at a time; edits during
  it go out afterwards against the version it returned, so the pane never
  409s against itself, and a poll issued before a save landed is ignored.
  A transport failure retries after 2, 5, then 10 seconds.
- **A 409 pauses autosave** until Reload or Overwrite. A file that is gone
  shows "Deleted on disk" with Close, and "Save to recreate" if the buffer is
  dirty — the only way it comes back.
- **Closing** (tab × or Alt-W) saves first and closes once that lands; only a
  save that cannot land asks before discarding. A dirty file's tab shows a dot,
  and `beforeunload` holds the page while any file is dirty.

### Keys

- **`open-files` (Alt-E)** is a registry command: it opens or surfaces the
  explorer and raises `filesFindPending`, and the mounted explorer focuses
  its filter — so Alt-E, a few letters, Enter is quick-open. Option-E is a
  dead key on macOS, the same trade every Alt-letter default makes.
- **Cmd/Ctrl-S is fixed**, not in the registry: like undo it is part of what
  an editor is. It is handled on the file pane's root, so it covers the header
  strip too, never reaches a terminal (Ctrl-S there is still the shell's),
  and keeps its browser meaning elsewhere. Because the workspace's shortcut
  listener runs first in the capture phase, `validateChord` refuses the
  platform's save chord and `mergeBindings` drops a stored override naming it.
  Cmd/Ctrl-F is fixed and reserved the same way: it opens the file pane's
  find bar (from the header strip as well as the editor, as does the header's
  search button) and jumps to the Changes pane's find box. So are the
  text-size chords, Cmd/Ctrl =/−/0.

Out of scope: preview tabs, per-column widths, LSP, collaborative cursors and
search across files (the terminal has `rg`).
