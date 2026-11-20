# Frontend components

The webapp (`packages/frontend`) is built from one catalog of components,
styled from one set of tokens. The catalog's rule: **a screen is built only
from catalog components; if a screen needs something new, it becomes a
component in the catalog first**, shown on the catalog page.

## Layout

```
packages/frontend/src/
  styles/tokens.css   the design tokens, mapped into Tailwind's theme
  ui/                 the catalog: Y* components behind the #ui barrel
  catalog/            the catalog page, every ui/ component in its states
  shell/              app-wide chrome: the logo menu, the command palette
  components/         the app's screens and regions: snapshot, store and API
                      in, ui/ components out
  lib/                non-visual logic (store, api, layout math, xterm …)
```

`components/` reads the snapshot, the store and the API directly and hands
plain props to `ui/`. A hook is pulled out only once two components need the
same data or actions (`useSiteActions`, `useWorkflowActions`); a hook with
one caller is a wrapper.

## Tokens

`styles/tokens.css` holds every colour, the type scale, control heights and
shadows. Each colour is written once as `light-dark(light, dark)`, so a theme
is only a `color-scheme`: `data-theme` on `<html>` (set before first paint),
or on a subtree that forces its own. `@theme inline` maps the raw tokens onto
Tailwind names:

| Kind | Utilities |
|---|---|
| Surfaces | `bg-shell` (rail, sidebar), `bg-surface` (work area), `bg-raised` (what floats), `bg-sunken` (inputs, code), `bg-hover`, `bg-selected` |
| Lines | `border-line`, `border-line-strong` |
| Text | `text-text`, `text-muted`, `text-subtle` |
| State | `accent`, `info`, `success`, `warning`, `danger`, each with `-soft` |
| Projects | `proj-<family>-fill/tint/ink/deep/glow`, eight families |
| Type | `text-xs` … `text-xl`: 11, 12, 13, 14, 16, 22px, each with its line height |
| Sizes | `h-bar` (44px bars), `h-control-xs/sm/md/lg` |

The design these encode:

- **Flush.** Regions sit edge to edge, cut by 1px lines. Only things that
  float or press (buttons, the active tab, menus) get a layered edge
  (`shadow-control`, `surface-control`). Corners are 4px on controls and 0
  everywhere else.
- **Colour is for state.** Amber means it needs you, red that it failed,
  green added lines. The accent marks focus and selection only; primary
  buttons are graphite.
- **Motion means progress.** Loaders and spinners while something loads,
  a running step's pulse, and the lanes on a working project's tile
  (YLanes); nothing moves for decoration.
- Geist for text, Geist Mono for real code only: diffs, terminals, paths,
  branches, commits.

Never name a colour after a size step (`--color-base`, `--color-lg`):
Tailwind would read `text-base` as that colour. xterm and CodeMirror take
their colours from `lib/terminalTheme.ts` and `lib/diffEditor.ts`, which
follow the tokens.

`cn()` (`ui/cn.ts`) joins class names with tailwind-merge, told this app's
scale names, so a `className` passed to a component overrides the
component's own class for the same property.

## The fence

eslint (`eslint.config.js`, the frontend block) keeps the catalog the only
place that styles a raw control:

- **`ui/` is pure.** It may not import the store, the API, the snapshot, the
  viewer, `@tanstack/*` or `#components`. Its components take props and
  raise events.
- **One door.** Everything outside `ui/` imports from the `#ui` barrel,
  never `#ui/<file>`. Inside `ui/`, files import each other relatively.
- **No raw controls outside `ui/`** (and the catalog page): no `<button>`,
  `<input>`, `<select>` or `<textarea>`, and no `@base-ui/react` import at
  all.
- **No pixel type sizes** (`text-[11px]`): use the scale. An inline
  `fontSize` is only for a glyph that scales with its box (a project
  tile's initial) or a size the user picks (text size).

A control with an unusual look still comes from `ui/`: `YButton`'s `bare`
variant (an unstyled button, for a row or a custom surface), its `link`
variant, `YFileInput`, `YRange`, and `bare` fields.

## The catalog page

`?catalog` on any server's origin renders `catalog/CatalogPage.tsx` instead
of the app: every `ui/` component in every state, then whole screens
composed from them, with a theme toggle.
`test-playwright-scripts/catalog-screens.js` screenshots it in both themes
and is the visual check for a change to `ui/`.

## Adding a component

1. Write it in `ui/`, on the tokens, with base-ui under anything
   interactive. Name it `Y<Name>`: the prefix never collides with base-ui's
   `Menu` or `Dialog`.
2. Export it from `ui/index.ts`.
3. Show it on the catalog page in each of its states.
4. Give it roles and `aria-label`s, so tests and Playwright scripts select
   it by role rather than by class.

Status marks (YStatus) and chips carry a text label, so colour is never the
only signal.

## How the screens are composed

- **The rail** (YProjectRail), under the sidebar's header: Home, a YProjectTile per project (its picture
  filling the tile if it has one; while agents work, lanes falling top to
  bottom behind it, with the picture's own solid background keyed out so
  they show through), add project, and
  the logo menu (settings, server health, servers, feedback, switching
  user).
- **The sidebar** (YSidebar) follows the rail. In the macOS desktop app
  its header spans the rail too, starting at the window's left edge, after
  room for the native traffic lights (YTrafficLights). Elsewhere the rail
  starts under an empty corner of its own, which holds the show-sidebar
  button while the sidebar is hidden, so the rail's line runs to the top. On Home it lists every
  project's sessions in status sections (Needs you, Working, Done). On a
  project its header shows the project's name, which opens the project's
  settings on General (where the project is also removed). Under its
  status badges sits New workspace, which always opens the create pane on
  Agent, and under that tabs (`SidebarTabs`) switch the list. Workspace
  lists the drafts and scheduled starts, then every running session in
  creation order (a workflow's, routine's or site's runs among them as
  plain rows) and the groups; Workflow lists the named workflows and
  routines and Site the sites, each with all its runs. Opening a workflow or site switches to
  its tab, and when the selected workspace is not on the open tab (just
  selected, or a run that stopped and is now listed only under its owner)
  the sidebar switches to one that lists it. Alt+K/J walks the Workspace
  tab's order whichever tab is open. Status shows only on each row, so rows never jump between
  sections. A workspace with
  several sessions lists them under its row on a tree line. There is no
  search box: the command palette (Alt+O) finds sessions, projects and
  actions.
- **Home** (`homeOpen` in the store, not a URL route): the sidebar, titled
  Inbox, lists every project's sessions, and the pane, titled Projects, is
  a grid of project cards. A wait's age shows only when the server knows
  it (`ServerSnapshot.startedAtMs`).
- **A workspace**: a top bar over the tile and tab pane layout of
  `lib/layout.ts`, unchanged by the catalog. Each pane is framed by
  YPanelHeader. Details is a pane target too: it holds what needs a look
  (the deadline, where it runs, git status, blocked hosts, unforwarded
  ports), and an amber dot on its icon says it lists something.
- **The chat pane** keeps its transcript as is; asks (permission, question,
  plan) dock above the composer as YAsk (`docs/permission-modes.md`).
- **Pages** (create, routine, workflow and site panes, settings) are a
  YPageBody of YSections, each holding a YSettingGroup of YSettingRows: a
  label, an optional short hint, and the control on the right. YCallout
  warns about the substrate where it matters (a containerless install's
  real credentials and environment).
