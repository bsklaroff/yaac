# Mobile layout

Below 767px the webapp's three desktop regions — the project rail, the
worktree list, and the pane — become three full-screen views the user walks
through: **projects → worktrees → pane**. Above it nothing changes; the same
three regions sit side by side.

## The breakpoint

One constant and one hook, in `packages/frontend/src/lib/viewport.ts`:
`MOBILE_QUERY` (`max-width: 767px`) and `useIsMobile()`. It is width-only, not
`pointer: coarse`, so a narrow desktop window gets the mobile shell too — which
is what makes it drivable from a Playwright script.

767px is Tailwind's `md` boundary, so a `max-md:` utility in a component means
exactly what the constant means. Keep them in step.

`loadViewMode`'s separate 1024px default answers a different question (how the
*pane* splits) and is unrelated.

## Screen state

`mobileScreen` lives in the ui store, persisted under `yaac.mobilescreen.v1`,
and is inert above the breakpoint — the desktop render path never reads it.

It is explicit rather than derived from `activeProjectSlug` /
`selectedWorktreeId`, which it looks like it could be. App fills the pane on
the user's behalf as soon as a project has a worktree, so a derived screen
would fling the user past the worktree list on every project tap. **Navigation
follows user intent**, and the store encodes that as a pair of actions per
change:

| A tap goes through | The app choosing goes through |
|---|---|
| `setActiveProject` → `worktrees` | `restoreActiveProject` (no move) |
| `selectWorktree` → `pane` | `autoSelectWorktree` (no move) |
| `openWorktree` → `pane` (a tray/notification jump, a just-created worktree) | — |

An eslint rule confines the two effect-side names to `App.tsx`, so reaching
for one from a component is a lint failure rather than a silently stranded
user.

A shared `?project=…&worktree=…` link does not go through `openWorktree` —
`loadSelection` reads it straight into the initial state — so `loadMobileScreen`
handles that case: with **nothing persisted**, those params mean a link opened
somewhere for the first time and it starts on the screen they point at. The two
conditions go together, because `persistSelection` mirrors the selection into
the URL on every change: after any use the params are always present, and on
their own they would drag every reload back to the pane.

`selectWorktree(null)` is a deselect (dismissing a failed provisioning row), so
it stays put. Clearing the project entirely — its removal — falls back to
`projects`, the only screen with anything left to do.

The consequence worth knowing: a cold load with nothing persisted lands on the
project list, even with one project, because nobody chose that project.

## Mounting: visibility, never display

All three screens stay mounted **and stay laid out**; one is visible.
`MobileScreenLayer` hides the others with `invisible pointer-events-none` plus
`inert`.

This is a correctness requirement, not an optimization. `WorktreeView`
positions every terminal by measured pixels — a `ResizeObserver` feeds
`computeColumns`, which feeds each pane's absolute rect — so a `display: none`
ancestor would collapse every rect to zero and make returning cost a full
resize round-trip to the pod. `visibility: hidden` keeps the box measured. It
is the same trick `WorktreeView` already uses for its own off-screen panes.

For the same reason the shell is *not* a translated `300vw` strip, tempting as
the slide animation is: a transformed ancestor becomes the containing block for
`position: fixed` descendants, which would silently relocate any non-portaled
overlay inside a screen.

The three regions also keep their slots in App's JSX across the breakpoint, so
the pane's wrapper stays the same `<div>` and merely changes class. That is
what keeps `WorktreeView` — and every kept-alive terminal under it — mounted
when a phone is rotated into landscape (844px wide, past the breakpoint). Only
the two navigation regions swap component, and they are cheap.

## Back

`lib/mobileHistory.ts` mirrors the screen into the browser history stack:
advancing pushes an entry, `popstate` reads the screen back out of it. The
header chevrons call `goBackScreen()`, which pops that stack — so the chevron,
the Android back button and the iOS edge swipe are one navigation.

Each entry carries a `yaacDepth` alongside its screen, and that — not a module
counter — is the record of how deep we are. It has to be: `popstate` fires for
forward navigation too, so a counter decremented on every pop undercounts after
a back-then-forward, and the chevron then duplicates entries and deadens the
next hardware back press. Reading depth off the entry the browser landed on
needs no notion of direction at all.

There is deliberately no "this change came from a popstate" flag either. After
a pop the browser has already moved, so the entry's stamped screen and the
store's screen agree and the sync effect early-returns on its own. A flag would
have to survive a store write that is a *no-op* whenever a pop lands on a
same-screen entry — and a stranded one swallows the next real navigation's
push, which shows up as back skipping a whole screen.

The exception `goBackScreen` does handle is a cold load that restored, say,
`pane` from localStorage: that entry is depth 0, the one we are standing on, and
`back()` there would walk out of the app. The chevron steps up by hand instead,
replacing the entry rather than pushing — going up is undoing a level.

A deep jump — `openWorktree` from a notification landing straight on the pane —
pushes one entry, so back returns to whichever screen the user was on rather
than stepping through a list they never saw.

`persistSelection` mirrors the selection into the URL with `replaceState` on
every change; it preserves the existing state object so the screen stamped
there survives.

## The screens

**Projects** is a list of named rows, not the rail scaled up: the rail's 40px
chips are a dense representation that works because they sit beside what they
scope, and as the only content on a phone they would be a column of unlabelled
letters. Same identity color (`lib/projectIdentity.ts`), plus the rail's footer
affordances as rows (`NewProjectButton` / `SettingsButton` take a
`variant="row"`).

**Worktrees** is the desktop sidebar's body — `WorktreeList`, shared verbatim,
which is what makes the mobile list order and the Alt+K/J cycle order provably
the same — under a mobile header with the project menu, skills and new-worktree.
No sidebar toggle: `sidebarOpen` is a desktop concept.

Touch has no hover, so below `md` each row's rename, group and delete actions
stop being `opacity-0 group-hover:opacity-100`, grow to finger size, and the
title's hover-marquee is disabled (a long title stays truncated; the pane
header shows it in full). Dragging a row between groups is mouse-only for the
same reason a pointerdown that preventDefaults would fight the scroll; the
group dialog's "move it to" list is the touch path to the same thing.

**Pane** is `WorktreeView` with a back chevron in place of the sidebar toggle.
Three things change:

- **Tabs mode is forced** — at render, never written to the store, so a user
  who prefers tiles on their desktop does not have that preference rewritten by
  opening the same server on a phone. It also disposes of the pane-drag /
  scroll conflict for free, since tabs-mode tabs are not draggable.
- **The header folds.** Desktop lays out eleven controls; a phone keeps the
  title and the alarm chits (git auth, blocked hosts, unforwarded ports — they
  say something is wrong and must not be buried) and moves new-shell, changes,
  preview and the forwarded-port links into a `⋯` menu.
- **Eager attach drops to 2** (from 12). Each pre-attached pane is a live
  `kubectl exec` PTY stream; twelve is a desktop-on-LAN number.

## Terminals and the soft keyboard

`#root` is sized to `var(--app-height, 100dvh)`, and on mobile
`useVisualViewportHeight` publishes `--app-height` from `window.visualViewport`.
By default a soft keyboard shrinks only the *visual* viewport — the layout
viewport stays full height behind the keyboard — so sizing to that would leave
the bottom of a terminal out of sight. Sizing to the visual viewport makes the
pane's ResizeObserver — and so the PTY's row count — track the space actually on
screen. The page meta asks for `interactive-widget=resizes-content` as well, so
that where it is supported the layout viewport shrinks too and the browser has
no room left to pan the shell around while someone types. `html`/`body` are
`overflow: hidden; overscroll-behavior: none` because every scroll in this app
belongs to a pane, never the page.

A phone keyboard has no Esc, Tab, Ctrl or arrows and every agent TUI needs all
four, so a terminal pane on mobile grows `TerminalKeyBar`. It is a sibling of
the measured workspace rather than an overlay, so the space it takes comes out
of the terminal's height and nothing hides behind it. Presses go through
`onPointerDown` + `preventDefault` — a tap that moved focus out of xterm's
hidden textarea would dismiss the keyboard, and the point is to press these
while typing.

The bar reaches the PTY through `lib/ptyInput.ts`, a small registry of mounted
panes: the socket is private to the `WorktreeTerminal` that owns it, and the
bar lives in `WorktreeView`'s chrome, so they meet there rather than by
threading a ref through the pane layout. The registered sender routes through
xterm's own `input()`, the same path a real keypress takes.

An **`acp` worktree needs none of this** — its pane is a chat composer, not a
terminal (`docs/agent-modes.md`) — which makes it the mode that works best on a
phone.

## The chat composer

Two rules keep `WorktreeChat` usable at 390px, on top of the 16px floor every
control gets (below). Both are about width: on a phone there is nowhere for
content to go but the pane.

- **The message list is `break-words`.** Overflow-wrap is inherited, so one
  declaration on the scroller covers every bubble, plan entry and tool row.
  Agents emit shas, URLs and object names — tokens with no break opportunity in
  them — and a single one is wide enough to turn the conversation into a
  sideways scroller. Fenced code is exempt by construction: it carries its own
  horizontal scroller, because breaking a line of code is worse than scrolling
  it.
- **The box grows with the message**, measured from its `scrollHeight` in a
  layout effect, up to the max-height at which it goes back to scrolling. A
  textarea is `rows` tall and scrolls its own content, which means writing a
  five-line message through a one-line slot.

## No text control under 16px

Mobile Safari zooms the page whenever a control smaller than 16px takes focus,
and it does not zoom back out. What the user is left with reads as a layout bug
— the pane runs off to the right, the whole shell pans under a finger — but it
is the browser scaling a page that no longer fits, and the control's font size
is the only thing that prevents it. The app's type scale is `text-xs` and
`text-[11px]`, so *every* input in it qualifies.

`index.css` raises `input, textarea, select, .cm-content` (CodeMirror's editing
surface is a contenteditable, which zooms the same way) to 16px below the
breakpoint. One rule rather than a `max-md:` utility per control, because the
failure is silent and the next input added would have to remember it. It wins
over the utilities despite their higher specificity because Tailwind's live in
`@layer utilities` and unlayered declarations outrank every layer — but not over
CodeMirror's own theme rules, which are unlayered *and* scoped one class deeper,
so an `EditorView.theme` setting a content font size would take the zoom back.

The same block sets `min-width: 0` on those controls, which is the bump's other
half: a control's automatic minimum size is its intrinsic width, which just
grew, so a flex row holding one stops shrinking and pushes its own submit button
off the screen. `min-width` only bites for flex and grid items, which is exactly
where that failure lives. Global for the same reason the size is — some of the
rows it protects (the remote-server form, reachable only from the desktop app)
are not walkable by the sweep that would otherwise catch the regression.

## Scrolling a terminal by touch

`lib/touch-scroll.ts` is what makes a swipe over a pane scroll it. Nothing
below it does: xterm has no touch handling — its viewport is a
transform-scrolled element with painted scrollbars, not a native overflow
scroller — and a browser synthesizes no wheel event from a touch pan, so the
wheel path (`lib/wheel-pacing.ts`) never fires either.

A pane's scrollback lives in tmux, which runs with `mouse on`, so the handler
translates finger travel into the same SGR wheel reports the mouse path sends —
one per five cell-heights, tmux's own `scroll-up -N 5`, which puts the content
roughly 1:1 under the finger. With nothing reporting — a pane app that turned
the mouse off, or a graceful detach, which resets the mode on its way out — the
same travel scrolls xterm's viewport instead. A *dropped* socket is not one of
those cases: nothing resets the parser's DECSET state, so reporting stays
nominally active and the reports are generated and then dropped at the closed
socket. Which is the right outcome anyway — the pane is alternate-screen for
the whole attach, so there is no local scrollback for the other branch to move.
Unlike the wheel path it needs no pacing: a wheel gesture outruns the
round trip because a trackpad keeps emitting after the fingers stop, whereas a
drag *is* the finger and cannot earn reports faster than tmux answers them.

Two details carry the rest of the behavior. `.xterm` is `touch-action: none`
(in `index.css`) — a touchmove the browser has already claimed for its own
panning is no longer cancelable, and canceling it is the whole mechanism. It is
`none` rather than the weaker `pinch-zoom` that would keep two-finger zoom over
the pane, because how long a browser leaves an unclaimed gesture cancelable is
engine heuristics and `none` is the only value with no hand-off to race. And
the gesture is only claimed past an 8px slop, so a tap stays a tap: below the
threshold nothing is preventDefault'd and the browser still synthesizes the
click `patchClickForwarding` hands to the TUI, while a swipe cancels that click
and so cannot also press whatever it started over.

There is deliberately no flick momentum. Every report is a round trip to the
pod, and the wheel pacer exists precisely to stop a gesture's tail from
scrolling the pane after the user stopped asking.

## Chrome

`viewport-fit=cover` in the page meta, and the shell's positioned container
carries `.safe-area-inset` so the screens stacked inside it with `inset-0` land
on its padding box and inherit clearance from the notch and home indicator.

The fixed-size dialogs go full-screen below `md`: Settings loses its two-column
split (the left nav becomes a scrolling row of chips), and the `inset-4`
overlays (skills, stopped worktrees, image builds) go edge to edge.

Going edge to edge is not enough for the three that are **master/detail** — a
20rem list beside a detail pane leaves the detail a few dozen pixels at 390px.
`components/ui/MasterDetail` is the shared body they render into: side by side
above `md`, one screen deep below it, where the list owns the width until a row
is tapped and the detail then takes over with a back chevron.

The off-screen pane is `max-md:hidden` — `display: none`, the mechanism the
screen layers above deliberately avoid, and here the right one: the visible
pane has to *have* the full width, which a still-laid-out sibling would deny
it. What made `display: none` unsafe there is absent here — nothing in these
overlays measures itself off-screen (the one self-measure, the build log's
`scrollTop = scrollHeight`, runs only while its pane is the visible one).

Both panes stay rendered, so the **list** keeps its scroll position and its
query across a drill-down and back. That is the list only: what the detail slot
holds is the caller's business, and the skills overlay swaps its detail for an
empty div on back, so re-tapping remounts the pane (its fetch is spared only by
React Query's 30s `staleTime`, and its own scroll resets).

Its `detailOpen` prop is "the user picked a row", not "a row is selected". Each
of these overlays auto-selects its first row so the desktop detail is never
blank, and that stand-in must not count as a navigation on a phone, so below
the breakpoint the auto-pick is skipped and the detail waits for a tap.

Which leaves the question of what may ride on the stand-in above the
breakpoint. Reads may — the desktop detail pane genuinely shows that row, so
its `SKILL.md` fetch and its build-log poll are the feature. A durable write
may not: the stopped overlay's death acknowledgement is cross-client and
irreversible, so it keys on the clicked row at every width. Otherwise merely
opening the overlay acknowledges the top death; each keystroke in the search
box re-filters the list, walking the stand-in through every match on the way to
the one the user wants; and `useIsMobile` is live, so rotating a phone into
landscape materializes a stand-in and acknowledges that.

The **stopped-worktrees entry point** under the list is the one control that
changes shape rather than size: a thin group-header-style line on the desktop,
a full-width tap-sized card on touch, so it reads as one more list row.

Elsewhere the rule is just that no row of controls may assume desktop width.
The global `min-width: 0` above keeps such a row from overflowing, but fitting
is not the same as usable: Settings' add-git-credential row leaves its token
field about 70px once both inputs are at the 16px floor, so it stacks below
`md`.

## Testing

`packages/frontend/test/`: `viewport.test.ts` (the hook and the visual-viewport
plumbing), `mobile-nav.test.ts` (the store's tap-vs-app-choosing split — the
`autoSelectWorktree` case is the regression the whole design exists to
prevent), `mobile-shell.test.tsx` (layer visibility and the history stack),
`mobile-overlays.test.tsx` (the master/detail drill-down: no auto-pick, no
detail-side fetch, and no death acknowledged until a row is tapped),
`worktree-list.test.tsx`, `pty-input.test.ts`, `terminal-key-bar.test.tsx`.

**The geometry is not covered by CI.** jsdom has no layout, so the behaviors
this design rests on — the hidden pane layer still measuring full-viewport, the
key bar sitting below the terminal rather than over it, the pane element
surviving a widen, tap-target sizes — are verified only by
`test-playwright-scripts/mobile-three-screens-test.js`, a standalone `node`
program nothing in `pnpm test` runs. A regression in exactly those behaviors
lands green. Re-run it by hand against a live server after any change to
`MobileScreenLayer` or `WorktreeView`'s layout math.

The 16px floor is the same kind of gap — a computed style, over a whole UI —
and is covered by `test-playwright-scripts/mobile-input-zoom-test.js`, which
walks the phone-width app, opens every dialog and pane that holds a control,
and prints the inventory it measured along with the verdict. Read the inventory:
a control the walk never reached passes vacuously, and the printed list (plus
its "never opened" line) is what shows that.

The chat composer's rules are the same kind of gap, and are covered by
`test-playwright-scripts/acp-chat-mobile-layout-test.js`: it needs a live
`acp` worktree, sends it one message carrying an unbreakable token, and
measures the pane's horizontal overflow, the input's font size and how the box
grows. It drives the built app rather than the Vite dev server, because
`React.StrictMode` double-mounts in development and the chat pane's second ACP
socket displaces its first, so a prompt sent from the box never arrives.

`test-playwright-scripts/mobile-overlay-panes-test.js` is the same kind of
check for the overlays — which pane is actually displayed and how wide, whether
anything overflows the viewport, whether every control clears a 32px tap
target, and whether the list's scroll offset really survives the hide/show.
jsdom can answer none of those: a `max-md:hidden` pane is present and "visible"
to it.

Touch scrolling is the same kind of gap for the same reason — every claim it
rests on is a browser fact jsdom has no opinion about. `touch-scroll.test.ts`
covers the translation from travel to reports; that the gesture is cancelable
at all, that canceling it suppresses the click, and that a swipe really moves a
`mouse on` tmux pane are covered by
`test-playwright-scripts/xterm-touch-scroll-test.js`, which drives real touch
input against a real tmux and needs no cluster.
