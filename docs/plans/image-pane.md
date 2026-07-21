# Image panes: view images from a session container in the webapp

## Context

Images never reach the webapp today. The terminal path is raw tmux bytes —
xterm.js ← WebSocket (`/pty/attach`) ← server node-pty running `kubectl exec
-it … tmux` (`src/server/pty-bridge.ts`) — so when an agent takes a screenshot
(Playwright + Chromium are baked into `dockerfiles/Dockerfile.default:27-56`,
`chrome-devtools-mcp` into `Dockerfile.tools:8`), all the user sees is the
file path printed in scrollback.

Fix chosen (from the option evaluation): serve images out-of-band through a
new authenticated server route, and render them in the webapp. Alternatives
rejected: in-band terminal image protocols (images wouldn't survive the
per-attach view-session reattach; agents don't emit them), and a watched
"artifacts dir" gallery (needs agent cooperation; can layer on later).

Decisions (confirmed with user):

- **Regular pane**, not a lightbox/overlay — an image opens as a first-class
  leaf in the existing tiling/tabs layout, exactly like a shell tab: it can
  be split, dragged, tabbed, and closed.
- **Serve any image path in the container**, not just `/workspace`. This
  forces the transport to `kubectl exec` (the host-side worktree shortcut
  only covers hostPath mounts) and means images are only viewable while the
  session is running — accepted.
- **No new npm dependencies.** Link detection uses xterm's core
  `registerLinkProvider` API (no `@xterm/addon-web-links`, which is
  URL-only anyway).

## Approach

### 0. Spike first: link clicks under tmux mouse reporting

tmux runs with `mouse on`, and the webapp already patches xterm's mouse
handling (`patchForcedSelection` / `patchKeepSelection`,
`src/frontend/lib/selection.ts`) so plain drag selects locally while
Alt+drag reports to tmux. Whether a plain click reliably activates an
xterm `ILinkProvider` link in that regime is unverified.

Before building the UI, write a Playwright script under
`test-playwright-scripts/` (committed, header comment saying what it
verifies and how to run it, per convention) that registers a scratch link
provider in the live webapp terminal and clicks a matched span with real
mouse events. If plain click misfires or conflicts with selection, fall
back to requiring the same Alt modifier used for tmux mouse handoff — the
script decides.

### 1. Backend: container file read helper

`src/lib/k8s/exec.ts` — new exported `containerReadFile(jobName, absPath,
maxBytes)`:

- **argv-based kubectl, no shells anywhere.** The path is user input;
  `shellKubectlWithRetry` (string through the host shell) would be an
  injection hazard. Use `kubectlWithRetry` (`src/lib/k8s/kubectl.ts:82`,
  `execFile`-based) with the path as its own argv element:
  1. `['exec', '-n', ns, execTarget(jobName), '--', 'stat', '-L', '-c',
     '%s', '--', absPath]` — existence + size check (`-L` so symlinked
     screenshots report the target's size). Map "No such file or
     directory" stderr → `ServerError('NOT_FOUND', …)`; size > `maxBytes`
     → `ServerError('VALIDATION', …, 413)`.
  2. `['exec', …, '--', 'base64', '--', absPath]` → decode with
     `Buffer.from(stdout.replace(/\s/g, ''), 'base64')`, return the Buffer.
- Extend `KubectlExecOptions` with `maxBuffer?: number`, plumbed into
  `execFileAsync` / `execFileWithInput` (`kubectl.ts:92-94,108`). Node's
  default 1 MiB `maxBuffer` is far below a base64-encoded screenshot; the
  read call passes ~1.4 × maxBytes.
- Export `MAX_IMAGE_BYTES = 32 * 1024 * 1024` (generous for screenshots,
  small enough that the base64 round-trip stays cheap).
- `stat`/`base64` come from coreutils in the Debian-based session images;
  a project image that strips them surfaces a clean 500, acceptable.

### 2. Backend: `GET /session/:id/image?path=…`

New route in `src/server/routes/session.ts`, following the `/:id/terminals`
pattern (`routes/session.ts:225`):

- `zValidator('query', z.object({ path: z.string().min(1) }))`.
- Normalize with `path.posix`: relative paths resolve against `/workspace`
  (the agent's cwd), `~/` against `/home/yaac`. No confinement beyond that
  — by design any container path is servable. This grants nothing the
  authenticated user doesn't already have via `/pty/attach` (a full shell
  as the same container user).
- Extension whitelist → MIME map, exported for tests: `png jpg jpeg gif
  webp bmp`. Anything else → `ServerError('VALIDATION', …)`. **`svg` is
  deliberately excluded**: served same-origin from the cookie-bearing
  server origin, a navigated-to SVG is a scriptable document — an XSS
  vector for agent-authored content.
- `resolveSessionContainer(c.req.param('id'), { requireRunning: true })` →
  `jobName`, then `containerReadFile`. Stopped sessions get the same error
  shape the terminals routes produce.
- Respond with the raw bytes: `Content-Type` from the map,
  `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` (the agent
  may overwrite the same path with a fresh screenshot; the pane owns
  refresh).

### 3. Frontend: image path detection in terminals

New `src/frontend/lib/image-links.ts`:

- `matchImagePaths(line: string): Array<{ start: number; end: number;
  path: string }>` — pure, exported, unit-tested. Matches absolute
  (`/…/shot.png`), home (`~/shot.png`), and relative (`./x.png`, bare
  `x.png`) tokens ending in a whitelisted extension (case-insensitive);
  no spaces inside paths (ambiguous in terminal output — accepted
  limitation); strips trailing punctuation (`.` `,` `)` `"` `'`).
- `resolveImagePath(raw: string): string` — relative → `/workspace/…`,
  `~/` → `/home/yaac/…`; exported for reuse by the route's mirror-image
  unit tests.
- `registerImageLinkProvider(term, onOpen)` — implements xterm
  `ILinkProvider` (core API, no `allowProposedApi` needed): join wrapped
  buffer lines the way `WebLinksAddon`'s LinkComputer does, map match
  offsets back to 1-based `IBufferRange`s, underline-on-hover decoration,
  `activate` → `onOpen(resolvedPath)`. Returns the `IDisposable`.

`SessionTerminal` (`src/frontend/components/SessionTerminal.tsx`) gains an
optional `onOpenImage?: (path: string) => void` prop; when set, register
the provider after `term.open(el)` (near the addon setup at `:98-120`)
and dispose it in the effect cleanup.

### 4. Frontend: the image pane

Image panes are client-side layout leaves — no tmux window, no server
state. Leaf targets are already plain strings (`'agent'`, `'shell:<name>'`,
`'window:@<id>'`), so add a fourth scheme: **`image:<abs path>`**.

Helpers in `image-links.ts` (exported, unit-tested): `imageTarget(path)`,
`isImageTarget(t)`, `imageTargetPath(t)`.

`SessionView.tsx` changes:

- **Layout sync** (`SessionView.tsx:142-155`): the reconcile effect removes
  leaves missing from the live tmux window list — skip `image:` leaves in
  the removal loop (they have no backing window) and never feed them to
  the `addLeafToLargest` re-add loop.
- **Open handler** passed down as `onOpenImage` to every `SessionTerminal`
  (bound to that pane's session id, not the selected one): if a leaf with
  the same target exists, just `focusTerminal` to it; otherwise
  `addLeafToLargest` + focus, mirroring `openShell` (`:197-214`) minus the
  server call.
- **`paneName`** (`:72-76`): image targets → `basename(path)`.
- **Pane body** (mounted loop at `:578-619`): branch on `isImageTarget` —
  render `<ImagePane sessionId={id} path={…} />` instead of
  `SessionTerminal`. Keep-alive works unchanged (the pane is cheap).
- **Close**: image panes get the header ×/tab × unconditionally, but both
  the click path and the Alt+W shortcut skip the `ConfirmDialog` and the
  `killSessionTerminal` call — closing destroys nothing; just drop the
  leaf and the `opened` entry.
- **Persistence**: layouts already persist to localStorage, so image panes
  reappear on reload and re-fetch; a stopped session yields the pane's
  error state.

New `src/frontend/components/ImagePane.tsx`:

- Fetch via a new `api.getBlob(path)` in
  `src/frontend/lib/apiClient.ts` (same `credentials: 'same-origin'` /
  `ApiError` handling as `request()`, but returns `res.blob()`), then
  `URL.createObjectURL` into an `<img>` with `object-fit: contain`,
  centered on the pane's `bg` block. Revoke the object URL on unmount and
  before each refetch.
- States: loading (reuse the `LoadingIcon` "Connecting…" pattern from
  `SessionTerminal.tsx:283-289`), error (the `ApiError` message — "No such
  file", "session not running", "too large" — plus a Retry button), and a
  small refresh control in the pane body so a re-taken screenshot at the
  same path can be reloaded (`no-store` keeps the fetch honest).

### 5. CSP

`src/server/static.ts:16`: `img-src 'self' data:` → `img-src 'self' data:
blob:` (object URLs). Direct `<img src={route}>` without the blob fetch was
considered — no CSP change — but rejected: failures render as an opaque
broken-image icon with no way to distinguish "file missing" from "session
stopped" from "too large". Update `test/unit/server/static.test.ts`.

## Testing

Unit (`test/unit/`, every new exported function covered per repo rule):

- `k8s/exec.test.ts`: `containerReadFile` — argv shape (no shell), stat →
  404 mapping, size cap → 413, base64 round-trip, symlink `-L` flag.
- `k8s/kubectl.test.ts`: `maxBuffer` plumbed through both exec paths.
- `server/session-image.test.ts` (mirroring `server/terminals.test.ts`):
  MIME map, relative/`~` resolution, non-image extension → 400 VALIDATION,
  svg rejected, missing file → 404, oversized → 413, `requireRunning`
  enforced, response headers.
- `frontend/image-links.test.ts`: matcher cases (absolute/relative/home,
  uppercase extensions, trailing punctuation, spaces rejected, multiple
  matches per line, wrapped-line joining), `resolveImagePath`, target
  helpers round-trip.
- `frontend/image-pane.test.tsx`: blob fetch success/error/retry, object
  URL revocation; `api-client.test.ts`: `getBlob`.
- SessionView layout sync: image leaves survive the terminals reconcile
  and are never server-killed (extend the existing frontend tests around
  layout/persist).

E2e (`test/e2e/`, needs a wired cluster; no new CLI args so the CLI-e2e
rule isn't triggered — this covers the transport instead): create a
session (`requirePrebuilt: true`, per-run namespace), write a small PNG
into the container via `containerExec` (`base64 -d` of a fixture,
including a path with spaces outside `/workspace`), `GET` the route with
the bearer secret, assert byte-for-byte equality and correct
`Content-Type`; assert 404 for a missing file and 400 for `.txt`.

Playwright (`test-playwright-scripts/`): the spike script from step 0
evolves into the end-to-end verification — echo an image path in a shell
pane, click the link, assert an image pane opens and renders.

`pnpm lint` before committing.

## Out of scope (deliberate)

- Gallery / watched artifacts dir (option B) — layers cleanly on this
  route later.
- Serving images from stopped sessions (would need a worktree-only
  host-side read path).
- SVG, PDFs, or generic file preview.
- In-band terminal image protocols (sixel / iTerm OSC 1337).
- Zoom/pan controls beyond contain-fit.
