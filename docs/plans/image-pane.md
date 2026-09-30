# Image panes: view a workspace's image files in the webapp

## Where things stand

- **Terminal panes** show raw tmux output (xterm.js over `/api/pty/attach`).
  When an agent takes a screenshot (Playwright and Chromium are in
  `dockerfiles/Dockerfile.default`, `chrome-devtools-mcp` in
  `Dockerfile.tools`), the user sees only the file path in scrollback.
- **File panes** exist (docs/file-editor.md). A `file:<path>` leaf opens a
  checkout-relative file read from the server's own filesystem, so it works
  for stopped workspaces too. `GET /workspace/:id/file` flags binary
  content, and `WorkspaceFile` then shows "Binary file, not shown". So an
  image inside the checkout can be opened but not seen.
- **Chat panes** (`acp` mode) already render image content blocks inline, as
  `data:` URLs (`useImageSrc` in `packages/frontend/src/lib/attachments.ts`).
- Images going the other way, from the user to the agent, are handled by
  paste/drop attachments (docs/agent-modes.md, "Images").
- The SPA's CSP (`spaCsp` in `packages/server/src/api/http/static.ts`) allows
  `img-src 'self' data:`.

What is missing: rendering an image file, and opening one from a path printed
in a terminal.

Rejected alternatives: in-band terminal image protocols (agents don't emit
them, and they would not survive a reattach), and a watched "artifacts dir"
gallery (needs agent cooperation; it can be layered on later).

## Decisions (confirmed with the user)

- An image opens as a regular layout pane, like a file or shell tab: it can be
  split, dragged, tabbed and closed. Not a lightbox.
- Any image path the workspace can see is viewable, not only files in the
  checkout. Paths outside the checkout are read through the driver's `exec`,
  so they are only viewable while the workspace runs. That is accepted.
- No new npm dependencies. Link detection uses xterm's core
  `registerLinkProvider` API.

## Plan

### 0. Spike: link clicks under tmux mouse mode

tmux runs with `mouse on`, and the webapp patches xterm's mouse handling
(`patchForcedSelection` / `patchKeepSelection` in
`packages/frontend/src/lib/selection.ts`) so a plain drag selects locally and
Alt+drag goes to tmux. It is unverified whether a plain click activates an
`ILinkProvider` link in that setup.

Before building the UI, write a Playwright script in `test-playwright-scripts/`
that registers a scratch link provider in a live terminal and clicks a match
with real mouse events. If a plain click misfires or fights selection, require
the Alt modifier instead. The script decides.

### 1. Images in file panes (checkout paths)

- New route `GET /workspace/:id/file/raw?path=` in
  `packages/server/src/api/routes/workspaces.ts`, backed by a function in
  `#domain/workspaces` (`files.ts`) that reuses the existing checkout-relative
  path resolution and `resolveWorkspaceRecord`. Like the other file routes it
  works for stopped workspaces and needs no driver verb.
- Only image extensions are served: `png jpg jpeg gif webp bmp`, mapped to a
  MIME type. Anything else is `VALIDATION` (400). SVG is excluded: served from
  the cookie-bearing server origin, a navigated-to SVG runs script, which makes
  agent-written SVG an XSS vector.
- Cap at `MAX_IMAGE_BYTES` (32 MiB) with `TOO_LARGE`.
- Response headers: the mapped `Content-Type`, `X-Content-Type-Options:
  nosniff`, `Cache-Control: no-store` (an agent may overwrite the same path
  with a new screenshot).
- `WorkspaceFile` renders an `<img>` instead of "Binary file, not shown" when
  the path has an image extension.

### 2. Images outside the checkout

- New route `GET /workspace/:id/image?path=<absolute path>`. It resolves the
  workspace with `resolveWorkspaceContainer(id, { requireRunning: true })`
  and reads through `workspaceDriver().exec`: `wc -c < <path>` for existence
  and size, then `base64 < <path>`, decoded on the server. Both forms are
  portable; GNU `stat -c`/`base64 <path>` would break on a macOS
  containerless host. The path
  goes through `shellQuote` (`#lib/shell`) because `exec` takes a shell
  command string. Same extension list, cap and headers as step 1. "No such
  file" maps to `NOT_FOUND`.
- There is no confinement beyond the extension check. This grants nothing a
  user doesn't already have through `/api/pty/attach`, which is a shell as
  the same user. Under `containerless` that shell is on the host, so the
  route reads host files the server user can read. That is the same trust as
  the terminal.
- Add the route to `test/api/route-matrix.ts` with its answer under both
  drivers.

### 3. Path detection in terminals

New `packages/frontend/src/lib/image-links.ts`:

- `matchImagePaths(line)` returns `{ start, end, path }[]`: absolute, `~/`
  and relative tokens ending in an image extension (case-insensitive), no
  spaces inside a path, trailing punctuation stripped.
- `registerImageLinkProvider(term, onOpen)` implements `ILinkProvider`: joins
  wrapped lines, maps matches to buffer ranges, underlines on hover, and calls
  `onOpen(path)` on activate.
- To decide which pane to open, the frontend needs the workspace's checkout
  and home paths. These differ by driver, so the workspace snapshot must
  carry them. The checkout is `WorkspacePaths.workspaceDir`; there is no
  home field yet, so add `homeDir` to `WorkspacePaths`, with each driver
  answering where its workspace's `$HOME` is. Relative paths resolve against the
  checkout. A path inside the checkout opens a `file:<relative path>` pane
  (step 1); any other path opens an `image:<absolute path>` pane (step 2).

`WorkspaceTerminal` takes an optional `onOpenImage` prop, registers the
provider after `term.open`, and disposes it on cleanup.

### 4. The `image:` pane

- `image:<abs path>` is a new client-side leaf scheme, next to `file:` and
  the others. It has no tmux window and no server state. Add
  `imageTarget` / `isImageTarget` / `imageTargetPath` helpers in the style
  of `packages/frontend/src/lib/files.ts`.
- `WorkspaceView`: add `image:` to `isSpecialPane`, so the layout reconcile
  keeps the leaf although no tmux window backs it (as for `file:` leaves). Opening an
  existing target focuses it; otherwise add a leaf and focus it. The pane
  name is the file's basename. Closing destroys nothing, so there is no
  confirm dialog and no terminal kill.
- `ImagePane` fetches the route as a blob, shows it with `object-fit:
  contain` through an object URL, and revokes the URL on unmount and before
  each refetch. It has loading and error states (showing the `ApiError`
  message: not found, not running, too large) and a refresh button.
- Layouts already persist, so image panes come back on reload and refetch.

### 5. CSP

Change `img-src 'self' data:` to `img-src 'self' data: blob:` for the object
URLs. A plain `<img src={route}>` would need no CSP change, but a failed load
shows only a broken-image icon, with no way to tell "missing" from "not
running" from "too large".

## Testing

- Server unit tests under `packages/server/test/` in the folder matching each
  module: the raw-file read (extension list, SVG refused, size cap, stopped
  workspace still served) and the exec read (quoting, `NOT_FOUND`, size cap,
  base64 round trip) with `exec` mocked at the driver boundary.
- `test/api`: the matrix rows, and write-route style behavior tests for both
  routes.
- Frontend unit tests in `packages/frontend/test/`: `matchImagePaths` cases
  (absolute, relative, `~`, uppercase extension, trailing punctuation,
  spaces, several per line, wrapped lines), target helpers, `ImagePane`
  fetch/error/retry and URL revocation, and `WorkspaceFile` rendering an
  image.
- `test/e2e-containerless`: in the suite's shared workspace, write a small
  PNG into the checkout and one outside it, fetch both routes, and compare
  bytes and `Content-Type`; assert 404 for a missing file and 400 for
  `.txt`. The k8s variant needs a cluster host.
- The Playwright spike grows into the end-to-end check: echo an image path
  in a shell pane, click it, and assert an image renders.

## Out of scope

- A gallery or watched artifacts dir.
- Reading non-checkout paths from a stopped workspace.
- SVG, PDF, or general binary preview.
- Terminal image protocols (sixel, iTerm OSC 1337).
- Zoom and pan beyond contain-fit.
