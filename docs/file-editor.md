# File editor

The webapp browses, edits and reviews a workspace's files through three
kinds of pane, all ordinary layout leaves next to terminals:

- **`files`**: the explorer, one per workspace. A tree, a filter that doubles
  as quick-open, a "show ignored" toggle, git status colors, line counts
  against the diff base, and create / rename / delete.
- **`changes`**: the Changes pane, one per workspace: the workspace's review
  diff. It is the same component as the explorer (`WorkspaceFiles` with
  `changedOnly`), listing only the changed files, each with its diff.
- **`file:<path>`**: one editor pane per open file (`<path>` is relative to
  the workspace root). Side-by-side files, tabs, drag, Alt-W, tab cycling and
  persistence across reloads all come from the layout, so there is no second
  tab system inside a pane.

Columns stay equal-width, so the explorer takes a full column. In tabs mode
and on phones, the filter (quick-open) is the way to find a file.

## Server

### Plain `fs` on the server's filesystem

`#domain/workspaces` (`files.ts`) reads and writes the checkout with plain
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
(docs/workspace-storage.md). The exceptions are the changes (which carry the
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
| `POST /workspace/:id/folder` | creates a folder and its missing parents; 409 if taken |
| `POST /workspace/:id/rename` | moves a file, folder or symlink; 409 if the destination exists |
| `DELETE /workspace/:id/file?path=` | deletes a file, a link (never its target) or a folder, recursively |
| `GET /workspace/:id/changes?base=&diff=&listing=&known=` | `WorkspaceChanges`: `{ base, baseResolved, files, diff, truncated, branch, comparison, listing? }`; `diff=0` leaves the `diff` field out, `listing=paths\|full` adds `WorkspaceFiles` unless its version is `known` |
| `GET /workspace/:id/file-at?path=&rev=` | `{ exists, content }`: the file at commit `rev` (a full object id), `content` null when binary or over 1 MiB |

### Changes

The webapp polls one route per workspace, `changes`, for the diff, the
status bar's counts and the explorer's listing. The changes are everything
that differs from the **diff base**: the merge
base of HEAD with the explorer's picked branch, else with the branch the
workspace forked from (`workspaceForkBranch`, tried as `origin/<base>`, then
local, then `@{upstream}`). One script (`#drivers/shared`'s
`workspace-changes.ts`) runs inside the workspace under either driver. It
runs `git add -A` into a private index at a stable scratch path, so the
whole working tree is diffed without touching the agent's index, and git's
stat cache keeps each poll incremental. `add -A` skips a tracked file that
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

A run whose exec timed out keeps going inside the workspace, holding the
private index. So each run takes a lock file of its own holding its pid: a
later run waits up to 10 seconds for a live holder and then answers
`RUNTIME_UNAVAILABLE` (503), and clears the lock of a holder that is gone or
over two minutes old. It also reads which **stages** each
file's changes sit in: `committed` (base → HEAD), `staged` (HEAD → the
agent's index), `modified` (the agent's index → the working tree, git's
unstaged changes) and `untracked` (in the working tree, not the agent's
index). Each is a tree-to-tree diff, so the working tree is walked once, by
`add -A`, however many stages are read. The agent's index becomes a tree
from a scratch copy, so the real one is never written or locked; with a
merge conflict it has no tree, and its changes count as `modified`.
`committed` is cached in the scratch dir by base and HEAD, since it changes
only when one moves. Each stage is its own diff, so their counts need not
sum to the file's totals.

The same run says how far HEAD is from the branch the base was found on
(`rev-list --left-right --count <ref>...HEAD`), so the status bar follows
the agent across a branch rename, and, when asked, lists the checkout:

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

The listing's sections are NUL-separated, since a path can hold a newline,
and print before the completion marker, so a run that died partway cannot
look like an empty checkout. It is capped at 50,000 paths (`truncated`). Its
`version` hashes the whole listing; the client sends it back as `known`, and
an unchanged listing is left out of the answer.

A file's original for the editor's diff modes comes from `file-at`, which
runs `git cat-file` on `<base>:<path>` inside the workspace (the old path for
a rename). The commit is the `base` the changes answer named, so the text
never changes and the client caches it for good.

### Git status bar

`GitStatusBar`, above a workspace's panes, shows the reference branch and how
far HEAD is ahead of and behind it, then the total changed lines
(`+52 −3`), which open the Changes pane. Both come from the
changes answer (`branch`, `comparison`, `files`), polled every 10 seconds
while the workspace is on screen. The bar also asks for `listing=paths`, so
the explorer's tree and the terminal's file links are ready before the
explorer opens.

It never fetches, so `behind` is only as fresh as the checkout's `origin/*`
(which the server keeps within minutes of origin, docs/server-git.md). The
bar shows `fetchedAt`, the newest mtime among:

- `server-local/git-fetched/`, a record each successful server fetch writes
  (git empties `FETCH_HEAD` even when a fetch fails);
- the checkout's `FETCH_HEAD`, for a fetch the agent ran;
- the branch reflogs in the main clone and the checkout, for a fetch that
  moved the branch.

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

Create, rename and delete do not touch git. Their effect shows in the colors
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
until its own fetch lands. On the server, `runChangesRead`
(`#drivers/shared`) runs one read of a checkout at a time, since each walks
the whole working tree: a request merges into the read queued behind the
running one, never into the running one, which could predate an edit the
caller just made. A failed poll leaves the last answer cached, so the status
bar shows the error in its place and both panes mark their tree "Not up to
date". When a picked base stops resolving (its branch was pruned), they
offer to compare with the fork branch again.

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
  with every diff open; a toggle switches to a tree, whose folders start
  open (so it records the closed ones). A diff mounts in 200-line chunks
  only as they come within a screen of view, so a change of hundreds of
  files opens at once. Out of view, a chunk holds the height it measured
  when last on screen, or, once its lines or the pane's width have changed
  since, an estimate of their wrapped height at the current width. Clicking
  a file's row folds its diff (remembered per file across both layouts), and
  only its name opens it. A header button collapses every diff while any is
  open, and shows them all once none is. A strip shows the diff base with a
  branch picker, the shown files' totals overall and per stage, and what the
  diff leaves out (only uncommitted work when no fork point resolves, a body
  cut at 1 MB). The filter matches paths (a rename's old one too) the way
  quick-open does, keeping the list's order.
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
- **Ignored files** come with every listing, so the toggle refetches nothing.
  A wholly ignored folder's children come from the `dir` route on first
  expand. The filter searches ignored files but not inside ignored folders.
- **Create / rename / delete** use an inline input (a `/` in the name creates
  folders), opened from the header or a row's menu (right-click, or the hover
  `⋯` on touch). A rename first saves every affected pane, since each
  remounts under its new path, and is refused with "Resolve unsaved changes
  first." if that fails. A delete cancels affected autosaves, confirms
  (counting a folder's files, noting a link goes without its target, listing
  unsaved panes), then closes those panes.

### Editor pane (`WorkspaceFile`)

The editor is CodeMirror via `ui/CodeEditor`. Its language comes from
`#lib/highlight` (`languageForPath` → `editorLanguage`), which the diff view
also uses, and its theme uses the app's CSS variables and the same `tok-*`
colors as the diff. The pane stays mounted while hidden, like a terminal, so
undo history, cursor and unsaved text survive.

- **Text size** is one store value, `editorFontSize` (default 12px, saved in
  localStorage), shared by file panes and settings editors. Change it with
  Cmd/Ctrl =/−/0 in the pane (matched on the character, so it works on any
  keyboard layout, and sizes the text instead of zooming the page) or the
  header's "Aa" popover. On phones, index.css pins editor text at 16px to
  stop iOS focus-zoom, so the button is hidden.
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
