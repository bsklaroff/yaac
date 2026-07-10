# Webapp UX

Standalone UI/UX design for the yaac webapp. This doc is only about
what the user sees and does — architecture and data flow live in
`webapp-frontend.md`. The server backend is already implemented in
`src/server/` (HTTP), with events and PTY work tracked in
`webapp-server-follow-up.md`. Iterate here freely; the other docs
should only need updating when a design change implies new
capabilities on the backend.

This doc describes the UX as built. Items not yet implemented are
called out inline with **PENDING**; ideas deferred past v1 live under
"Future UX". When the shipped UX and the original design diverged,
the shipped behavior wins here.

## Guiding principles

- **Mirror the data model, not the CLI command shape.** Users think
  in projects and sessions, not in imperatives. The rail and sidebar
  are the map; commands are the actions you take on the map.
- **Terminal-first.** The first-class experience is an attached
  tmux session. Config editing, file browsing, diffs — secondary.
- **Never hide session state.** Status, prompt, blocked hosts,
  forwarded ports, prewarm failures — all visible without a click.
  If it shows up in `yaac session list`, it should show up in the
  webapp.
- **Confirm destructive actions.** Session delete, project remove,
  "open in external editor" first-time.
- **Keyboard-reachable.** The CLI is the escape hatch; the webapp
  should still be fast for the common loop — create session, attach,
  detach, delete.
- **One event loop from the backend, live updates everywhere.** No
  "refresh" button. The server pushes a full snapshot over the
  `/events` WebSocket on connect and after each loop tick; the
  webapp re-renders within a tick. If the CLI creates a session
  while the webapp is open, it appears on its own.

## Overall layout

```
┌──┬─────────────────┬───────────────────────────────────────────┐
│ A│  sidebar        │  session view                             │
│ B│  (project A)    │  ┌────────────┐ ┌────────────────────┐    │
│ •│                 │  │ Agent      │ │ shell-1            │    │
│ C│  ▾ Waiting (1)  │  │            │ │                    │    │
│  │    • session 1  │  │ xterm      │ │ xterm              │    │
│ +│  ▾ Running (2)  │  │            │ │                    │    │
│  │    • session 2  │  └────────────┘ └────────────────────┘    │
│  │    • session 3  │  ┌─────────────────────────────────────┐  │
│  │  ▸ Deleted (4)  │  │ window: dev server                  │  │
│ ⚙│  + new session  │  │ xterm                               │  │
└──┴─────────────────┴───────────────────────────────────────────┘
   ↑ project rail
```

Three columns:

- **Project rail** (far left, fixed narrow) — a Discord/Slack-style
  vertical strip of project icons. The top-level navigation axis.
- **Sidebar** — scoped to the single active project selected in the
  rail. Lists that project's sessions, grouped by status.
- **Session view** — the selected session's terminals, laid out as a
  tiling workspace of floating, rounded, bordered pane cards.

The chrome is the browser's, not a native window. No custom
titlebar; the app fills whatever tab or window the user opens it in.

The sidebar can be toggled closed (a button in the session-view
header) to give the terminals more room; the rail stays.

## Project rail

The always-visible top-level map. A thin vertical strip of one icon
per project, rendered from the live project list.

### Project icon

- A rounded square showing the project's initial, tinted with a
  deterministic per-project color derived from the slug (quantized
  OKLCH hue, so adjacent projects stay visually distinct and every
  hue reads at the same perceived lightness in the dark palette).
- The active project's icon squares off and brightens; inactive ones
  are rounder and dimmer, squaring on hover (the familiar rail
  affordance).
- **Attention badge** — a small dot when the project has one or more
  sessions awaiting input, so "which project needs me" is answerable
  before drilling in. This is the rail-level equivalent of the
  sidebar's Waiting group.
- Click selects the project; that scopes the sidebar and clears the
  open-session selection.

### Rail actions

- **"+" (new project)** below the project icons — opens the add-
  project modal (see below).
- **⚙ settings** pinned at the bottom — opens the settings modal
  (credentials + general).

There is no per-project context menu on the rail today. Project
actions live in the sidebar header (see below); the only one is
**Remove project**.

## Sidebar

Scoped to the active project. The session map for that one project.

### Header

- The **project name** doubles as the project actions trigger:
  clicking it opens a small menu. Today that menu has a single item,
  **Remove project** (with a confirm dialog naming the slug —
  removes the project, its sessions, and its worktrees). Rename /
  duplicate-config are not built.
- A **reconnecting…** hint appears here while the events WebSocket is
  down.
- A **"+" new-session** control (see below).

### Session groups

Sessions are not shown as a flat list with per-row status pills.
They're bucketed into **collapsible groups in triage order**, each
showing a count and a chevron:

- **Waiting** — agents idle, awaiting user input (open by default;
  the rows you most likely want to attach to).
- **Running** — agents working (open by default).
- **Deleted** — collapsed by default; see below.

Status (`waiting` vs `running`) is conveyed by which group a row sits
in, matching the CLI's triage ordering so both views agree. Note the
backend session status is only `running | waiting` — there is no
`prewarm` status surfaced as a session row. Prewarmed spares are an
implementation detail of create; they're not listed here.

### Session row

Per row:

- **Title** — the user-assigned display title, falling back to the
  truncated first user message, falling back to "New session".
  Ellipsis on overflow.
- **Tool label** — the tool name as **text** (Claude / Codex /
  OpenCode). Not an icon: the icon library has no brand glyphs, so
  tools are labeled by name. The label yields to a delete **×** on
  row hover.
- **Relative created-at** ("3m ago"), from the session's UTC time.
- **Blocked-hosts badge** — a small count chip (with a ban glyph)
  when > 0, titled with the host list.

Clicking anywhere on the row selects the session and opens its
session view in the main area. Deleting is the hover **×** at the
row's right edge (it overlays the tool label) → a confirm dialog →
optimistic hide, then the server's detached cleanup drops it from the
snapshot. A deleted session that had history reappears in the Deleted
group.

### Deleted group

Sessions whose container and worktree are gone but whose transcript
was kept. Collapsed by default and hidden entirely when empty.
Lazy-loaded and re-fetched whenever the active-session set changes
(so a just-deleted session shows up and a restarted one drops out).
Clicking a deleted row restarts it — recreating the container and
resuming the tool from where it left off — via the same optimistic
"starting…" provisioning flow as a fresh create, after a confirm.

### New session

The **"+" new-session** control in the sidebar header is a tool-pick
**dropdown** (not a modal): it lists the available tools (Claude /
Codex / OpenCode, defaulting visually to the user's preferred tool).
Picking one fires the create immediately and the menu closes. The
session id is generated up front, so:

- A **provisioning row** appears at once in the sidebar with a
  spinner and live progress ("Pulling image…"), and is auto-selected
  so progress streams into the main pane.
- The optimistic row bridges the gap until the server's snapshot
  carries the id; from then the snapshot is the source of truth
  (it survives a reload, carrying live progress).
- On failure the row stays, shows "failed", and offers a dismiss ×.
- Once the real session lands it replaces the row and stays selected,
  opening its first terminal.

**PENDING:** add-directory pickers for read-only (`--add-dir`) and
read-write (`--add-dir-rw`) mounts, and the absolute-path validation
that would accompany them. There is no add-dir UI yet.

### New project

The rail "+" opens a real **modal** (Base UI Dialog): a single input
for a git repo URL, with the server's error surfaced verbatim (e.g.
`AUTH_REQUIRED` when no git credential matches the host). On success
it selects the new project.

**PENDING:** `owner/repo` shorthand with an inline preview of the
expanded URL, and a sidebar "cloning…" placeholder. Today the submit
button shows a busy "Adding…" state and the project simply appears
when the clone lands.

### Empty states

Minimal today:

- No project selected (e.g. before any project exists): the sidebar
  reads "No project selected".
- Project with no sessions: "No sessions yet — start one with +".

**PENDING:** a richer welcome panel / first-run walkthrough (GitHub
token → tool login → add first project). None of that exists; the
first-run experience is just the empty strings above plus the
settings modal.

## Session view

Selected when the user clicks a session row. Dominated by the
terminals; metadata is peripheral.

### Tiling workspace (shipped)

The main area is a **tiling window manager**, not a simple tab strip.
What was once deferred as "split panes" is built:

- Each session's terminals render as floating pane cards arranged by
  a per-session **layout tree**. The default is a single **Agent**
  pane.
- **Split** a pane right or down from its hover controls, or open
  another terminal into it; panes carve the space recursively.
- **Drag a pane header** to rearrange: drop onto another pane's edge
  to split it, or drop near a **workspace edge** (root-edge drop) to
  give the pane a full-height/width half of the whole workspace.
- **Drag the dividers** between panes to resize; ratios persist.
- **Tiles ↔ Tabs toggle** in the header. Tabs mode renders the same
  layout-tree leaves one at a time (better on small screens; small
  viewports default to tabs). The tree stays canonical, so toggling
  back to tiles restores the arrangement.
- **Layouts persist** across reloads, keyed by session id (ids are
  stable across restart, so a restored session gets its layout back).

### Terminals

- Each pane is an xterm.js instance attached to a session terminal
  over the server's `/pty/attach` WebSocket. Every terminal is a
  window of the `yaac` tmux session: the primary **Agent** window,
  initCommands **windows** (dev servers, watchers), and scratch
  **shells** (plain windows named `shell`, `shell-2`, …).
- **Panes mirror the live window list**: every window shows by
  default (init panes included), new windows get a pane by splitting
  the largest one, and windows that close drop out — killed elsewhere,
  or a `hidePane` init window exiting when its command finishes. The
  user's arrangement is otherwise kept.
- **"New shell"** buttons (header, tab strip, and pane split
  controls) create a fresh window via the server and open its pane
  immediately.
- The pane **(x) kills the window** — after a confirm dialog, since
  it terminates whatever runs in it. The agent pane has no (x).
- Every shown terminal stays mounted (hidden) so switching back is
  instant; scrollback is preserved for the lifetime of the view.
- Resize propagates to the PTY automatically (the fitted size is sent
  up-front so full-screen TUIs don't garble on cold start).
- Copy/paste uses the platform-standard bindings (⌘C/⌘V on mac,
  Ctrl+Shift+C/V elsewhere); tmux mouse mode means plain drags go to
  tmux, while a modifier forces a local selection.

### Header

A slim bar above the workspace. It carries:

- Sidebar toggle.
- Session **title** (title → prompt → "New session").
- Tiles/Tabs toggle.
- Add-terminal menu.
- Tool **label** (text).
- Blocked-hosts chip (count + ban glyph, titled with the host list).
- The session **kebab** (see below).

**PENDING in the header:** container short id, a status pill, and
**forwarded-port chips**. The data exists on the backend (a
`PortMapping` type is defined) but ports are not yet surfaced in the
UI; the chips that would open `http://127.0.0.1:<hostPort>` in a new
tab are not built.

### Kebab menu (session actions)

Today: **Rename** (edit the display title via an input dialog) and
**Restart** (kill + resume the same session id). **Delete** is not
in this menu — it lives on the sidebar row's hover **×** (a single,
optimistic delete path).

**PENDING:** copy session id, copy worktree path, and "open worktree
in external editor" (the server-side spawn of the configured host
editor, with a first-use confirm). None are built.

### No-session state

When a project has sessions but none is selected, the main area shows
"No sessions yet" until one is picked. A selected provisioning row
shows its creating/restarting placeholder (with live progress or a
failure + dismiss) in place of the terminal until it lands.

## Project view — PENDING

There is **no project-detail view**. Clicking a project in the rail
only scopes the sidebar. The following were designed but are not
built:

- **Meta pane** — slug, remote URL, added-at, default branch, last
  fetch, active-session count.
- **Config editor** — a Form view of known `yaac-config.json` fields
  (env, mounts/cache, containers, networking, proxy allowlist) and a
  Raw JSON view with schema validation (Monaco). No editor, Form or
  raw, exists; there is no Monaco dependency in the frontend.
- **Per-project credentials readout** — which git token pattern
  matches the remote, which tool credential is active.
- **Danger zone** — a typed-slug-confirmation project delete. Today
  project removal is a plain confirm dialog in the sidebar header's
  project menu, not a typed confirmation, and not in a project view.

## Settings modal

The rail ⚙ opens a single Notion-style **Settings modal** — a left
nav of sections over a scrollable content pane. Two sections exist:

### General

- **Default tool** (Claude / Codex / OpenCode) — the initial pick
  when creating a session.

**PENDING:** everything else the preferences pane was meant to hold
(see Preferences below).

### Credentials

A read-only listing plus one add action:

- **Configured** — a non-editable list of git credentials (pattern +
  masked preview) and tool auth (tool · kind · masked key).
- **Add git credential** — a form for an HTTPS token against a host
  pattern (e.g. `github.com/*`).

This replaces the originally-designed standalone, fully-featured auth
modal. **PENDING** within credentials:

- An **editable, reorderable** git-token table (first match wins),
  per-row reveal/delete, pattern-shape validation.
- A **Claude Code** tab with "Log in with OAuth" via an embedded
  terminal running the native `claude login` over the PTY bridge, or
  an API-key input.
- A **Codex** tab (API-key input + clear).
- Any tool-auth editing at all (the list above is read-only for tool
  credentials).
- A first-run credential walkthrough.

## Preferences — mostly PENDING

The only preference exposed is **Default tool** (in Settings →
General, above). Designed-but-not-built:

- Theme (system / light / dark).
- External editor command template (for "open worktree in editor").
- Terminal font family / size, cursor style.
- "Show prewarm entries in the sidebar" toggle.
- Advanced: reveal server logs, restart server.

(The tiles/tabs **view mode** is a real persisted preference, but it
lives on the session-view header toggle and in local storage, not in
this pane.)

## Keyboard

Terminal-switching is webapp-level (webapp panes attach with tmux
`prefix None`, so there are no tmux bindings to reach for — see
`webapp-server-follow-up.md`):

- **Alt+← / Alt+→** (same on every platform) — previous / next
  terminal (tab-strip order), wrapping; in tiles mode it moves
  keyboard focus between panes. Trade-off: shadows ⌥←/⌥→ word-jump
  inside macOS terminal panes and the browser's Alt+←/→ history
  navigation.

The chords are captured window-level before xterm sees them, and the
tmux status bar is off in webapp panes — the tab strip is the only
window list (the CLI's `yaac session attach` keeps the status bar
and stock tmux bindings).

Still pending: the designed **"jump to next waiting session"**
shortcut. Within a terminal, the copy/paste bindings described above
also apply.

## Notable shipped behaviors not in the original design

- **OpenCode** is a first-class third tool everywhere a tool is
  chosen or labeled (alongside Claude and Codex).
- **Token bootstrap auth.** The app gates on a session cookie: on
  load it either consumes a one-time bootstrap code from the URL or
  probes a protected endpoint, and shows a **BootstrapSplash** to
  authenticate when needed. The events WebSocket only connects once
  authed.
- **Session rename** and **persisted per-session layouts** (described
  under Session view) are both shipped and were not in the original
  v1 scope.

## Future UX

Designed for but deliberately not built yet:

- **File browser tab.** Within a session view, a tree of the
  worktree; clicking a file opens it in an inline Monaco editor pane.
  `.md` files offer a WYSIWYG toggle.
- **Diff sidebar.** A collapsible right-hand panel showing
  `git status` and per-file diffs against the merge base; clicking a
  file opens it in the file browser.
- **Monitor dashboard.** A full-screen view resembling
  `yaac session monitor` — all projects, all sessions at a glance,
  sorted by waiting-ness — for picking a session before drilling in.
- **Rich prompt history.** Beyond the first user message, a timeline
  of the session's user turns in a collapsible panel.
- **Notifications.** When a session transitions from `running` to
  `waiting` while the tab is backgrounded, fire a Web Notifications
  API notification (one-time permission). The tmux bell is already
  relayed to attached clients at the infra level; the browser-facing
  notification is not wired up.
