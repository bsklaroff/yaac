# Tauri UX

Standalone UI/UX design for the yaac desktop app. This doc is only
about what the user sees and does — architecture and data flow live
in `tauri-frontend.md`, and the backend in `tauri-daemon.md`.
Iterate here freely; the other two docs should only need updating
when a design change implies new capabilities on the backend.

## Guiding principles

- **Mirror the data model, not the CLI command shape.** Users think
  in projects and sessions, not in imperatives. The sidebar is the
  map; commands are the actions you take on the map.
- **Terminal-first.** The first-class experience is an attached
  tmux session. Config editing, file browsing, diffs — secondary.
- **Never hide session state.** Status, prompt, blocked hosts,
  forwarded ports, prewarm failures — all visible without a click.
  If it shows up in `yaac session list`, it shows up in the GUI.
- **Confirm destructive actions.** Session delete, project delete,
  credential wipe, "open in external editor" first-time.
- **Keyboard-reachable.** The CLI is the escape hatch; the GUI
  should still be fast for the common loop — create session, attach,
  detach, delete.
- **One event loop from the backend, live updates everywhere.** No
  "refresh" button. If state changes (CLI creates a session while
  the GUI is open), the GUI reflects it within a tick.

## Overall layout

```
┌─────────────────┬──────────────────────────────────────────────┐
│  sidebar        │  main area                                   │
│                 │                                              │
│  ▾ project A    │  ┌──────────────────────────────────────┐    │
│    • session 1  │  │ tabs: [attach] [shell] [+]          │    │
│    • session 2  │  ├──────────────────────────────────────┤    │
│  ▸ project B    │  │                                      │    │
│                 │  │ xterm                                │    │
│  + new project  │  │                                      │    │
│                 │  │                                      │    │
│  ⚙ auth         │  └──────────────────────────────────────┘    │
│  ⚙ prefs        │  footer: session meta, ports, blocked hosts  │
└─────────────────┴──────────────────────────────────────────────┘
```

Fixed-width sidebar on the left (resizable). Main area swaps
between three modes: session view (terminal tabs), project view
(config + meta), or a welcome / empty state.

## Sidebar

The sidebar is the always-visible map. Rendered from a live list of
projects, each of which expands to show its sessions.

### Project row

- Project slug, session count, expand/collapse caret.
- Click the slug → open project detail in the main area.
- Click the caret → expand/collapse the session list.
- Hover → "+" button for new session; right-click → context menu
  (rename (future), duplicate config (future), delete).

### Session row

Per running or waiting session:

- Short id (first 8 chars).
- Tool icon — Claude or Codex.
- Status pill:
  - `waiting` — agent is idle waiting for user input (colored
    prominently; this is the row the user most likely wants to
    attach to).
  - `running` — agent is working.
  - `prewarm` — container ready, not yet claimed (deemphasized).
- Relative created-at ("3m ago"), expands to ISO on hover.
- Truncated first user message. Ellipsis with a tooltip showing the
  full prompt. Same truncation rule as today's `session-list.ts`.
- Blocked-hosts badge — small count chip if > 0; click expands an
  inline list of hosts under the row.

Clicking anywhere on the row selects the session and opens or
activates its session view in the main area.

Sort order within a project: `waiting` first, then `running`, then
`prewarm`, ties broken by created-at ascending — matches the CLI's
`session-list.ts` `statusOrder` logic so both views agree.

### Actions

- "+ session" under each expanded project → modal (see below).
- "+ new project" button near the top → modal.
- Settings area at the bottom: ⚙ auth (credentials modal), ⚙ prefs.

### New-session modal

- Tool dropdown, default = user's preferred tool.
- Add-directory pickers for read-only (`--add-dir`) and read-write
  (`--add-dir-rw`). Native OS file picker for each; selected paths
  shown as chips with a trash icon. Absolute-path validation with
  inline error.
- Submit → modal closes, sidebar shows a "creating…" placeholder
  row with a spinner; the real row replaces it once the session
  lands. Auto-selects the new session and opens an attach tab.

### New-project modal

- Single input: GitHub HTTPS URL or `owner/repo` shorthand. Inline
  preview shows the URL the backend will use after shorthand
  expansion. Validation errors (SSH URLs, non-GitHub hosts, invalid
  URL) surface inline, verbatim from the backend.
- Submit → modal closes, "cloning…" placeholder in the sidebar
  until the project appears.

### Empty states

- No projects yet: welcome panel in the main area with a single CTA
  — "add your first project". Sidebar shows the same "+ new project"
  button pinned.
- Project with no sessions: the session list reads "no sessions —
  new session" where "new session" is a clickable inline link that
  opens the modal.

## Session view

Selected when the user clicks a session row. Dominated by the
terminal; metadata is peripheral.

### Tab strip

- First tab opens automatically when the session is selected. It's
  the tmux-attach tab (equivalent to `yaac session attach`). Label:
  `tmux` (or the session's primary tool name, TBD).
- "+" adds a new terminal — creates a new tmux window inside the
  same session. Visible from a CLI attach too, which is the point.
- Tabs are draggable-reorderable within a session. Tab close → "X"
  on hover or middle-click; closing the last tab detaches but keeps
  the session selected (showing a "reattach" CTA in the main area).
- Tab title: mode name. Future: allow rename.

### Terminal body

- xterm.js instance filling the main area below the tab strip.
- Scrollback preserved locally per tab for the lifetime of the
  session view; switching tabs doesn't clear it. Reselecting a
  previously-attached tab resumes its stream.
- Resize propagates to the PTY automatically.

### Header

Sits above the tab strip (or collapses into a single-row "chrome"
bar):

- Container short id.
- Tool name.
- Status pill (same as sidebar).
- Forwarded-port chips: each chip shows `hostPort → containerPort`;
  click opens `http://127.0.0.1:<hostPort>` externally (in a future
  phase, inside an in-app iframe tab — see Future UX).
- Blocked-hosts chip: count; click expands the list as a popover.

### Kebab menu (session actions)

- Copy session id.
- Open worktree in external editor. First use prompts to confirm
  and pick the editor (VSCode by default). Preference persisted.
- Copy worktree path.
- Delete session — confirm modal listing the session id and first
  user message. On submit, the row grays out optimistically and
  dissolves once the backend confirms.

### No-sessions state for a selected project

If the user clicks a project and it has no sessions, the main area
shows the project view (below) instead of a session view.

## Project view

Opened by clicking a project name in the sidebar.

### Meta pane

- Project slug and remote URL (click to copy).
- Added-at date.
- Default branch, last fetch time.
- Number of active sessions (links back to the sidebar).

### Config editor

Two view modes, toggled with a tabbed switcher:

1. **Form** — structured inputs for each known field. Grouped:
   - Environment: `envPassthrough`, `envSecretProxy`.
   - Mounts & cache: `bindMounts`, `cacheVolumes`, `initCommands`.
   - Containers: `nestedContainers`, `hideInitPane`.
   - Networking: `portForward`, `pgRelay`.
   - Proxy allowlist: `addAllowedUrls` / `setAllowedUrls` (mutually
     exclusive; UI enforces this before the backend does).
   Each field shows a help hover with the same prose as the README.
2. **Raw JSON** — Monaco with schema validation. Same schema the
   backend parser uses; errors render inline before save.

Save button is disabled until valid; "revert" restores the last
saved state.

A banner at the top of the editor makes clear which file is being
edited:
- "editing the in-repo `yaac-config.json` (visible in the repo, but
  saved as a per-machine override)" — when there's no override yet.
- "editing the per-machine override" — once one exists. Offer a
  "remove override and use repo file" action that deletes the
  override.

### Credentials readout for this project

Small non-editable panel:
- Which GitHub token pattern matches this project's remote (resolved
  by the backend, since matching is non-trivial for wildcards).
- Which tool credential is active (Claude OAuth vs API key, Codex).
- "Update credentials" link opens the credentials modal.

### Danger zone

Delete project — confirm modal lists:
- The project slug and remote URL.
- Every live session that will be torn down.
- What gets removed on disk (`~/.yaac/projects/<slug>/`) — worktrees,
  cached packages, config override, transcripts.

Typed-confirmation (user must type the slug) before the button
enables.

## Credentials / auth modal

Opened from the sidebar ⚙ auth button. Top of the modal is a
read-only summary:

- GitHub tokens — table of patterns with masked token suffixes.
- Claude Code — kind (OAuth / API key), masked value, expiration
  (OAuth).
- Codex — same shape.

Three tabs for edit actions, mirroring the three CLI `auth update`
branches:

### GitHub tokens tab

- Editable table with patterns + tokens. Rows drag-reorderable (the
  first matching pattern wins — the CLI documents this; the UI
  makes it visible).
- Pattern validation: `*`, `<owner>/*`, `<owner>/<repo>`. Inline
  error on invalid shapes.
- Token input is a password field; on blur, the token gets masked
  in place (show the last 4 chars). "Reveal" button next to each
  row reveals briefly.
- Per-row delete (with confirm). Save persists the whole table.

### Claude Code tab

- Two options: "Log in with OAuth" or "Use API key".
- OAuth: button starts the native `claude login` flow inline in an
  embedded terminal panel within the modal. The user follows
  prompts (paste code, confirm, etc.) exactly as they would in the
  CLI. On success the summary updates.
- API key: password input + save.
- Current credential displayed above with "remove" action.

### Codex tab

Same structure as Claude — API key input + clear action. (Codex
has no OAuth today.)

### First-run flow

When the app launches with no credentials configured, the welcome
panel in the main area is modified: it walks the user through
(1) GitHub token, (2) Claude or Codex login, (3) "add your first
project". Each step can be skipped and revisited later via the
auth modal.

## Preferences pane

Accessed via sidebar ⚙ prefs. Single scrolling pane:

- Default agent tool (Claude / Codex) — affects "+ new session"
  defaults and prewarm behavior.
- Theme: system / light / dark.
- External editor for "open worktree in editor" (default VSCode;
  customizable command template).
- Terminal font family / size, cursor style.
- "Show prewarm entries in the sidebar" toggle (on by default).
- Advanced: "reveal daemon logs", "restart daemon".

## Keyboard

- **Jump to next waiting session** — a single shortcut cycles
  selection to the next `waiting` session in the sidebar. Replaces
  the CLI's `yaac session stream` mode without needing a dedicated
  GUI surface.

## Future UX

Designed for but not in v1:

- **File browser tab.** Within a session view, a second tab group
  pane shows the worktree as a tree. Click a file → opens in an
  inline Monaco editor tab alongside terminal tabs. `.md` files
  offer a WYSIWYG toggle.
- **Diff sidebar.** A collapsible right-hand panel in session view
  showing `git status` for the worktree and per-file diffs against
  the merge base. Clicking a file opens it in the file browser.
- **Port preview tabs.** Forwarded-port chips in the header gain a
  second action: "preview in tab", which opens the URL inside an
  in-app iframe tab (in a separate webview to keep the main CSP
  strict — see `tauri-frontend.md` for the architecture question).
- **Split panes.** Drag a tab to the edge of the terminal area to
  create a horizontal or vertical split. Each pane is independent.
  Useful for running an attached agent and a shell side by side.
- **Monitor dashboard.** A full-screen view resembling
  `yaac session monitor` output — all projects, all sessions, at a
  glance, sorted by waiting-ness. For users who want the bird's-eye
  view before picking a session to attach to.
- **Rich prompt history.** Beyond the first user message, a
  timeline of the session's user turns shown in a collapsible panel.
  Useful for quickly finding a session in a large list.
- **Notifications.** When a session transitions from `running` to
  `waiting` while the window is backgrounded, a native OS
  notification fires so users can context-switch on signal.

