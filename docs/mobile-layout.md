# Mobile layout

Below 767px wide, the webapp's three desktop regions (project rail, workspace
list, pane) become three full-screen views the user moves through:
**projects → workspaces → pane**. Above that width nothing changes.

## The breakpoint

`packages/frontend/src/lib/viewport.ts` defines `MOBILE_QUERY`
(`max-width: 767px`) and `useIsMobile()`. The check is width-only, not
`pointer: coarse`, so a narrow desktop window gets the mobile shell too, which
lets a Playwright script drive it. 767px is Tailwind's `md` boundary, so
`max-md:` utilities mean the same thing. Keep them in step.

(`loadViewMode`'s 1024px default is unrelated: it decides how the pane splits.)

## Screen state

`mobileScreen` lives in the ui store, persisted under `yaac.mobilescreen.v1`.
The desktop layout never reads it.

It is stored rather than derived from the selection, because the app fills
the pane on its own whenever something other than a tap empties the
selection (a project switch, a deleted workspace). A derived screen would
then skip the user past the workspace list on every project tap. So the
screen moves only on user intent, and the store has a separate action for the
app's own choices:

| A tap goes through | The app choosing goes through |
|---|---|
| `setActiveProject` → `workspaces` | `restoreActiveProject` (no move) |
| `selectWorkspace` → `pane` | `autoSelectWorkspace` (no move) |
| `openWorkspace` → `pane` (tray/notification jump, just-created workspace) | — |

An eslint rule allows the two right-hand actions only in `App.tsx`, the store
and the delete flow (`lib/stopWorkspaceFlow.ts`, which selects the row below a
deleted open workspace). Calling one from a component is a lint error.

A shared `?project=…&workspace=…` link is read straight into the initial
state by `loadSelection`, bypassing `openWorkspace`. So `loadMobileScreen`
starts on the screen the params point at, but only when nothing is persisted.
Both conditions matter: `persistSelection` mirrors the selection into the URL
on every change, so after any use the params are always there, and on their
own they would send every reload to the pane.

`selectWorkspace(null)` is a deselect (dismissing a failed provisioning row)
and does not move. Removing the active project falls back to `projects`.

So a cold load with nothing persisted lands on the project list, even with
one project, because nobody chose it.

## Hide with visibility, never display

All three screens stay mounted and laid out. `MobileScreenLayer` hides the
inactive ones with `invisible pointer-events-none` plus `inert`.

This is required for correctness. `WorkspaceView` positions each terminal by
measured pixels (a `ResizeObserver` feeds `computeColumns`). Under a
`display: none` ancestor every rect collapses to zero, and returning would
cost a full resize round-trip to the workspace. `visibility: hidden` keeps the
box measured.

The shell is not a translated `300vw` strip either, despite the easy slide
animation: a transformed ancestor becomes the containing block for
`position: fixed` descendants, silently moving any non-portaled overlay.

The three regions keep the same slots in App's JSX on both sides of the
breakpoint, so the pane's wrapper `<div>` only changes class. That keeps
`WorkspaceView` and its kept-alive terminals mounted when a phone rotates to
landscape (844px, past the breakpoint).

## Back navigation

`lib/mobileHistory.ts` mirrors the screen into browser history: moving
forward pushes an entry, and `popstate` reads the screen back. The header
chevron calls `goBackScreen()`, which pops, so the chevron, Android back and
the iOS edge swipe are one navigation.

- **Depth lives on the entry** (`yaacDepth`), not in a counter. `popstate`
  also fires going forward, so a counter decremented on each pop undercounts
  after back-then-forward, and the chevron then duplicates entries.
- **No "came from popstate" flag.** After a pop the entry's screen and the
  store's already agree, so the sync effect returns early by itself. A flag
  can be left set when a pop lands on a same-screen entry (the store write is
  a no-op), and then swallows the next real push, making back skip a screen.
- **Cold load.** If the app restored, say, `pane` from localStorage, that
  entry is depth 0 and `history.back()` would leave the app. The chevron
  instead goes up one level by replacing the entry.
- **Deep jumps** (`openWorkspace` from a notification) push one entry, so back
  returns to where the user was, not through a list they never saw.

`persistSelection` updates the URL with `replaceState` and keeps the existing
state object, so the stored screen survives.

## The screens

**Projects** is a list of named rows. The rail's 40px chips only work beside
what they scope; alone they would be a column of unlabelled letters. Rows use
the same identity color (`lib/projectIdentity.ts`), and `NewProjectButton`
and `SettingsButton` render as rows (`variant="row"`).

**Workspaces** reuses the desktop sidebar's `WorkspaceList` as is, so list
order matches the Alt+K/J cycle order. It sits under a mobile header with the
project menu, skills and new-workspace. Touch has no hover, so below `md` each
row's rename, group and delete actions are always shown and finger-sized, and
the title's hover marquee is off. Dragging rows between groups is mouse-only
(a preventDefault on pointerdown would fight scrolling); the group dialog's
"move it to" list covers touch.

**Pane** is `WorkspaceView` with a back chevron in place of the sidebar toggle:

- **Tabs mode is forced** at render, never written to the store, so a desktop
  tiles preference survives opening the server on a phone. Tabs are not
  draggable, which also avoids a drag vs. scroll conflict.
- **The header folds.** The title and the alarm chips (git auth, blocked
  hosts, unforwarded ports) stay, since they report problems. New shell,
  Changes, Files, Preview and forwarded-port links move into a `⋯` menu
  (`PaneOverflowMenu`).
- **Eager attach drops to 2** (from 12). Each pre-attached pane is a live PTY
  stream; twelve suits a desktop on a LAN, not a metered radio.

## Terminals and the soft keyboard

`#root` is `position: fixed` at `var(--app-top, 0px)` with height
`var(--app-height, 100dvh)`. On mobile, `useVisualViewportHeight` sets both
from `window.visualViewport`.

- **Height.** A soft keyboard shrinks the visual viewport but not the layout
  viewport, so sizing to the layout viewport would hide the terminal's bottom
  rows. Sizing to the visual viewport makes the pane's `ResizeObserver`, and
  so the PTY's row count, match what is on screen. The viewport meta also sets
  `interactive-widget=resizes-content`, which shrinks the layout viewport
  where supported.
- **Offset.** iOS does not support that, and its keyboard also slides the
  visual viewport: focusing the chat composer scrolls it into view and never
  scrolls back. The app is then the right size but sits above the visible
  area, with page background and a draggable gap below. `--app-top` is that
  slide, so the fixed root covers the visible area exactly.
- **Zoom.** A pinch-zoom pans the visual viewport too, but that pan is the
  user's. So the hook publishes `0` while `scale` is above 1.01. The margin
  exists because a browser may leave `scale` slightly off 1 after a pinch, and
  a strict `> 1` would switch the keyboard fix off for good.

A fixed root is not a containing block for fixed descendants (only transforms
and similar create one), so overlays still position against the viewport.
`html` and `body` are `overflow: hidden; overscroll-behavior: none`: every
scroll belongs to a pane, never the page.

A phone keyboard lacks Esc, Tab, Ctrl and arrows, which every agent TUI needs,
so a mobile terminal pane gets `TerminalKeyBar`. It is a sibling of the
measured area, not an overlay, so its height comes out of the terminal's.
Keys fire on `onPointerDown` with `preventDefault`, so pressing one does not
move focus out of xterm and dismiss the keyboard. The bar reaches the PTY
through `lib/ptyInput.ts`, a registry of mounted panes (the socket is private
to its `WorkspaceTerminal`). The sender goes through xterm's `input()`, the
same path as a real keypress.

An `acp` workspace needs none of this: its pane is a chat composer
(docs/agent-modes.md), which makes it the mode that works best on a phone.

## The chat composer

`WorkspaceChat` has three rules for narrow screens, on top of the 16px minimum
below:

- **The message list is `break-words`.** `overflow-wrap` is inherited, so one
  class covers every row. Agents print SHAs and URLs with no break
  opportunities, and one is enough to make the conversation scroll sideways.
  Fenced code keeps its own horizontal scroller instead.
- **The input grows with the message**, from its `scrollHeight` in a layout
  effect, up to a max height where it scrolls again.
- **The list stays pinned when the pane shrinks.** A scroller keeps its
  `scrollTop` when its box shrinks, so opening the keyboard would push the
  latest messages out of view. A `ResizeObserver` re-pins it, but only if the
  reader was already at the bottom.

## No text control under 16px

Mobile Safari zooms the page when a control with text under 16px takes focus,
and never zooms back out. It looks like a layout bug (the pane runs off the
right and the shell pans under a finger). The app's type scale is `text-xs`
and `text-[11px]`, so every input is affected.

Below the breakpoint, `index.css` sets `input, textarea, select, .cm-content`
to 16px (`.cm-content` is CodeMirror's contenteditable, which zooms the same
way). It is one global rule because the failure is silent and a per-control
utility would be forgotten. It beats Tailwind utilities because those are in
`@layer utilities`, and unlayered rules outrank layers. It does not beat
CodeMirror's own theme rules (unlayered and more specific), so an
`EditorView.theme` that sets a content font size would bring the zoom back.

The same rule sets `min-width: 0`. A flex or grid item's minimum width is its
intrinsic width, which just grew, so a row holding the input would stop
shrinking and push its submit button off screen. It is global because some
affected rows (the remote-server form, desktop app only) are not reached by
the Playwright sweep.

## Scrolling a terminal by touch

`lib/touch-scroll.ts` makes a swipe scroll a terminal pane. xterm has no touch
handling (its viewport uses transforms, not a native scroller), and browsers
generate no wheel events from a touch pan, so the wheel path
(`lib/wheel-pacing.ts`) never fires.

Scrollback lives in tmux, which runs with `mouse on`. The handler turns finger
travel into the same SGR wheel reports the mouse sends, one per five
cell-heights (tmux scrolls 5 lines per report), which keeps content roughly
under the finger. When mouse reporting is off (the pane's app disabled it, or
a clean detach reset it), the travel scrolls xterm's own viewport instead. On
a dropped socket reporting stays nominally on and the reports are discarded,
which is fine: the pane is in the alternate screen and has no local scrollback.

A flick keeps gliding after the finger lifts. The release velocity comes from
the last 100ms of event timestamps (so queued moves on a busy thread do not
read as fast) and decays with iOS's 500ms time constant. The glide starts at
most at about one report per frame, so it cannot outrun tmux. A frame more
than 100ms late (backgrounded tab, locked phone) ends it. Touching the pane
stops a glide, and that touch's touchend is canceled so it is not also a tap.

- `.xterm` has `touch-action: none` (`index.css`). A touchmove the browser
  has claimed for panning can no longer be canceled, and canceling is the
  whole mechanism. `pinch-zoom` would keep two-finger zoom, but how long a
  gesture stays cancelable then varies by engine; `none` has no race.
- The gesture is claimed only past 8px, so a tap stays a tap: the browser
  still generates the click that `patchClickForwarding` passes to the TUI. A
  swipe cancels that click.

## Chrome

The viewport meta sets `viewport-fit=cover`, and the shell's container has
`.safe-area-inset`, so screens inside it clear the notch and home indicator.

Below `md`, fixed-size dialogs go full screen. Settings' left nav becomes a
scrolling row of chips, and the `inset-4` overlays (skills, stopped
workspaces, image builds) go edge to edge.

Those three overlays are list/detail layouts, and a 20rem list leaves the
detail a few dozen pixels at 390px. `components/ui/MasterDetail` is their
shared body: side by side above `md`, one at a time below it (the list until
a row is tapped, then the detail with a back chevron).

- **The hidden side uses `max-md:hidden`** (`display: none`). Here that is
  right: the visible side needs the full width, and nothing in these overlays
  measures itself while hidden.
- **The list keeps its scroll and query** across drill-down and back, since
  both sides stay rendered. What the detail keeps is up to the caller (the
  skills overlay remounts its detail each time).
- **`detailOpen` means "the user picked a row"**, not "a row is selected".
  Each overlay auto-selects its first row so the desktop detail is never
  blank; below the breakpoint that auto-pick is skipped.
- **Only reads may ride on the auto-picked row.** The stopped overlay's death
  acknowledgement is a durable, cross-client write, so it keys on the clicked
  row at every width. Otherwise opening the overlay, typing in its search box,
  or rotating a phone to landscape would each acknowledge a death the user
  never picked.

The stopped-workspaces entry point under the workspace list changes shape: a
thin header-style line on desktop, a full-width tap-sized card on touch.

Elsewhere, no row of controls may assume desktop width. `min-width: 0` stops
overflow, but fitting is not usable: Settings' add-git-credential row stacks
below `md` because its token field would be about 70px wide.

## Testing

Unit tests in `packages/frontend/test/`: `viewport.test.ts`,
`mobile-nav.test.ts` (the tap vs. app-choosing split; the
`autoSelectWorkspace` case is the regression this design prevents),
`mobile-shell.test.tsx` (layer visibility, history stack),
`mobile-overlays.test.tsx` (no auto-pick, no detail fetch, no death
acknowledged until a tap), `workspace-list.test.tsx`, `pty-input.test.ts`,
`terminal-key-bar.test.tsx`, `touch-scroll.test.ts`.

**Layout is not covered by CI.** jsdom has no layout engine, so the geometry
this design depends on is checked only by standalone Playwright scripts in
`test-playwright-scripts/`. Nothing in `pnpm test` runs them, so a regression
there passes CI. Run the relevant one by hand after changing what it covers:

| Script | Checks |
|---|---|
| `mobile-three-screens-test.js` | hidden layers still measure full-viewport, the key bar sits below the terminal, the pane survives a widen, tap-target sizes. Re-run after changing `MobileScreenLayer` or `WorkspaceView`'s layout math. |
| `mobile-keyboard-slide-test.js` | fakes `window.visualViewport` moving like a keyboard and a pinch-zoom, and checks `#root` covers the visible area. Needs no workspace. |
| `mobile-input-zoom-test.js` | opens every dialog and pane with a control at phone width and prints the measured font sizes. Read the inventory: a control never reached passes vacuously. |
| `acp-chat-mobile-layout-test.js` | on a live `acp` workspace, sends an unbreakable token and measures overflow, input font size and growth. Uses the built app, since `React.StrictMode`'s dev double-mount makes the second ACP socket displace the first. |
| `mobile-overlay-panes-test.js` | which master/detail side is shown and how wide, overflow, 32px tap targets, list scroll surviving hide/show. |
| `xterm-touch-scroll-test.js` | real touch input on a real `mouse on` tmux: cancelable gesture, suppressed click, actual scrolling. Needs no cluster. |
