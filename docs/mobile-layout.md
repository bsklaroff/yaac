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

Touch has no hover, so below `md` each row's pin and delete stop being
`opacity-0 group-hover:opacity-100`, grow to finger size, and the title's
hover-marquee is disabled (a long title stays truncated; the pane header shows
it in full).

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
The layout viewport does not shrink when a soft keyboard opens (iOS Safari just
slides the page), so sizing to it would leave the bottom of a terminal behind
the keyboard. Sizing to the *visual* viewport makes the pane's ResizeObserver —
and so the PTY's row count — track the space actually on screen. `html`/`body`
are `overflow: hidden; overscroll-behavior: none` because every scroll in this
app belongs to a pane, never the page.

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

## Chrome

`viewport-fit=cover` in the page meta, and the shell's positioned container
carries `.safe-area-inset` so the screens stacked inside it with `inset-0` land
on its padding box and inherit clearance from the notch and home indicator.

The fixed-size dialogs go full-screen below `md`: Settings loses its two-column
split (the left nav becomes a scrolling row of chips), and the `inset-4`
overlays (skills, stopped worktrees, image builds) go edge to edge.

## Testing

`packages/frontend/test/`: `viewport.test.ts` (the hook and the visual-viewport
plumbing), `mobile-nav.test.ts` (the store's tap-vs-app-choosing split — the
`autoSelectWorktree` case is the regression the whole design exists to
prevent), `mobile-shell.test.tsx` (layer visibility and the history stack),
`worktree-list.test.tsx`, `pty-input.test.ts`, `terminal-key-bar.test.tsx`.

**The geometry is not covered by CI.** jsdom has no layout, so the behaviors
this design rests on — the hidden pane layer still measuring full-viewport, the
key bar sitting below the terminal rather than over it, the pane element
surviving a widen, tap-target sizes — are verified only by
`test-playwright-scripts/mobile-three-screens-test.js`, a standalone `node`
program nothing in `pnpm test` runs. A regression in exactly those behaviors
lands green. Re-run it by hand against a live server after any change to
`MobileScreenLayer` or `WorktreeView`'s layout math.
