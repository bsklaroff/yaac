# File editor

The webapp browses and edits a workspace's files through two kinds of pane,
both ordinary layout leaves next to terminals and Changes:

- **`files`**: the explorer, one per workspace. A tree, a filter that doubles
  as quick-open, a "show ignored" toggle, git status colors, and
  create / rename / delete.
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
both drivers behave the same. The cost: node-local checkouts
(docs/plans/node-local-checkouts.md) would need an in-pod path.

Every file route resolves the workspace's record (`resolveWorkspaceRecord`),
so a stopped workspace's files open and save like a running one's
(docs/workspace-storage.md). The exceptions are the listing and the git status
bar, which run git inside the workspace. For a stopped workspace they return
`CONFLICT`, shown as "Start the workspace to browse its files".

Ownership needs no handling: the server already runs as the workspace's user
(the install uid from `installSecurityContext()` on k8s, the host user under
macOS virtiofs, the same process user under containerless).

| Route | Answer |
|---|---|
| `GET /workspace/:id/files` | `WorkspaceFiles`: `paths`, `symlinks`, `ignored`, `emptyDirs`, `status`, `truncated` |
| `GET /workspace/:id/dir?path=` | the immediate children of one folder (capped at 5,000) |
| `GET /workspace/:id/file?path=&known=` | `{ path, version, size, binary, content? }` |
| `PUT /workspace/:id/file` | `{ path, content, baseVersion }` → `{ path, version, size }`, or 409 |
| `POST /workspace/:id/folder` | creates a folder and its missing parents; 409 if taken |
| `POST /workspace/:id/rename` | moves a file, folder or symlink; 409 if the destination exists |
| `DELETE /workspace/:id/file?path=` | deletes a file, a link (never its target) or a folder, recursively |
| `GET /workspace/:id/git-status?base=` | `WorkspaceGitStatus`: `{ base, comparison: { ref, ahead, behind, fetchedAt? } \| null }` |

### Listing

The server never runs git against a checkout's git dir, which belongs to the
workspace (docs/server-git.md). So `listCheckoutFiles` (`checkout-git.ts`)
runs one script inside the running workspace over the driver's `exec`. That
git reads the workspace's config, and whatever the config runs, runs as the
workspace. Each command's output is NUL-separated and followed by a section
marker, so a run that died partway cannot look like an empty checkout.

- `ls-files --cached --others --exclude-standard`, minus `ls-files --deleted`,
  gives `paths`. Git applies `.gitignore`, so there is no JS reimplementation.
- `ls-files --others --ignored --exclude-standard --directory` gives
  `ignored`, with a wholly ignored folder (`node_modules/`) as one entry.
- `ls-files --others --exclude-standard --directory` lists untracked folders.
  Git does not track folders, so these are walked (through pinned descriptors,
  not following links, skipping ignored folders) to find ones with no listed
  file. Those are `emptyDirs`, which keep a "New folder" visible on the next
  poll.
- `status --porcelain=v1 -z --untracked-files=all --ignore-submodules=all`
  gives one `FileStatus` per path: `modified`, `added` (including a rename's
  new path), `untracked` or `conflicted`. Deletions are dropped. These colors
  mean "differs from HEAD"; Changes shows "differs from the fork base". It
  runs with `--no-optional-locks`, so polling never writes the index under
  the agent's git.

The listing is capped at 50,000 paths (`truncated`). Each path is `lstat`ed
to find symlinks, which answer `{ target, dir }`: `target` is relative to the
workspace, or null when broken or outside it.

### Git status bar

`GitStatusBar`, above a workspace's panes, shows the reference branch and how
far HEAD is ahead of and behind it. `checkoutAheadBehind` runs
`rev-list --left-right --count <base>...HEAD` inside the running workspace,
so it follows the agent across a branch rename. The base is the Changes
pane's pick, else the workspace row's fork branch (`workspaceForkBranch`),
tried as `origin/<base>` and then as a local branch, like the Changes diff.

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

A save never creates a file: a non-null `baseVersion` for a missing file is a
409 with `version: null`, which stops autosave from bringing back a deleted
file. Only `baseVersion: null` creates, with `O_CREAT | O_EXCL | O_NOFOLLOW`
in the pinned parent (making missing folders), never through a link.

Create, rename and delete do not touch git. Their effect shows in the colors
and in Changes, as `mv` or `rm` in a terminal would.

## Webapp

`#lib/files` holds the pane targets, the API client and pure helpers:
`buildTree` (folders take their strongest child's status), `filterPaths`
(case-insensitive subsequence, best first, max 200), `fileTabLabels` (a
basename plus enough parent path to tell two `index.ts` apart) and
`placeFile`. `placeFile` follows VS Code's "open in the active editor group":
a tab in the column holding the active file pane, else in any column with a
file pane, else a new column right of the explorer, else at the end.
`renameTargets` in `#lib/layout` updates every `file:` target under a renamed
path.

### Explorer (`WorkspaceFiles`)

Like Changes, it unmounts when off-screen, so a hidden explorer runs no
listing; while visible it refetches every 5 seconds. Its view state
(expanded folders, scroll, filter, show-ignored) is in the store's
`paneView`, shared with Changes.

- **Tree.** Only rows under expanded folders render, so a large repo needs no
  virtualization. Files get an icon and tint from `languageForPath`.
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
- **A 409 pauses autosave** until Reload or Overwrite. A deleted file shows
  "Deleted on disk" with Close, plus "Save to recreate" if the buffer is
  dirty; that is the only way a deleted file comes back.
- **Closing** (tab × or Alt-W) saves first and closes once the save lands;
  only a save that cannot land asks before discarding. A dirty tab shows a
  dot, and `beforeunload` warns while any file is dirty.

### Keys

- **`open-files` (Alt-E)** is a shortcut-registry command. It opens or
  focuses the explorer and sets `filesFindPending`, so the explorer focuses
  its filter: Alt-E, a few letters, Enter is quick-open. (Option-E is a dead
  key on macOS, like every Alt-letter default.)
- **Cmd/Ctrl-S, Cmd/Ctrl-F and Cmd/Ctrl =/−/0 are fixed**, not in the
  registry. Cmd/Ctrl-S is handled on the file pane's root, so it works from
  the header strip, never reaches a terminal (Ctrl-S stays the shell's there),
  and keeps its browser meaning elsewhere. Cmd/Ctrl-F opens the file pane's
  find bar, or jumps to the Changes pane's find box. Because the workspace's
  shortcut listener runs first (capture phase), `validateChord` refuses these
  chords and `mergeBindings` drops a stored override that uses one.

Out of scope: preview tabs, per-column widths, LSP, collaborative cursors, and
search across files (the terminal has `rg`).
