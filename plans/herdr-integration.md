# Drive yaac sessions from herdr — via a separate `yaac-herdr` repo

## Context

[herdr](https://github.com/ogulcancelik/herdr) is a Rust terminal multiplexer
where every pane is a **real local PTY running an arbitrary command**, and it
classifies each pane's agent state (`working`/`blocked`/`done`/`idle`) by
**screen-scraping the rendered TUI** against bundled TOML manifests. It ships
manifests for **Claude Code, Codex, and OpenCode** — exactly yaac's three tools —
so state detection needs zero cooperation from the in-pod process.

We want herdr as the front-end with **yaac Kubernetes pods running the agents
underneath**. The two systems already meet at a TTY, and yaac needs almost
nothing: **`yaac session create <project>` already provisions *and* attaches**
(`src/commands/session-create.ts:147-160` — `kubectl exec -it … tmux attach`,
`stdio:'inherit'`), and `yaac session attach <id>` (`session-attach.ts`) attaches
to an existing one. Dropping either into a herdr pane renders the live Claude TUI,
fully state-detected, today.

Two constraints from the user shape the design:

1. **No reconcile / sync loop.** herdr is a **launcher**, not a synced mirror:
   sessions are opened into panes on demand; teardown happens when the attach
   process exits or via an explicit delete action. No background diff loop.
2. **Keep the integration in a separate `yaac-herdr` repo.** yaac is **MIT**
   (`LICENSE.md`); herdr is **AGPL-3.0-or-later**. To avoid licensing
   contamination, the yaac repo must contain **no references to herdr** — no
   plugin, no `herdr` shell-outs, no herdr names. All glue lives in a separate
   repo that can itself be AGPL.

Decisions locked earlier: **herdr-driven (plugin)** depth, **same machine**
topology. Decision locked now: yaac-herdr talks to yaac via **generic,
herdr-agnostic CLI flags** (not the internal server HTTP API).

## Architecture (two repos, no reconcile)

```
  herdr (AGPL, unchanged)  ──spawns pane cmd──▶  yaac-herdr (AGPL, NEW repo)
        ▲                                              │  shells out to:
        └────── herdr CLI (workspace/agent/pane) ──────┤──▶ herdr  (AGPL CLI)
                                                        └──▶ yaac   (MIT CLI)
  yaac (MIT)  ── generic --json/--detach flags only; ZERO herdr references
```

- **yaac repo (MIT):** add only **generic scriptability flags** so *any* tool can
  drive it headlessly. No herdr mention anywhere.
- **yaac-herdr repo (AGPL-3.0-or-later, new):** a small `yaac-herdr` CLI + a
  herdr plugin manifest. It shells out to the **`yaac` CLI** and the **`herdr`
  CLI** as separate processes (the same convention yaac uses for `kubectl`) — no
  linking, so it is not a derivative of either binary; AGPL covers its own code
  and the plugin.

Binding between worlds is encoded in herdr's own state (no shared DB, no loop):
- **herdr workspace `label` = yaac project slug** (created lazily per project).
- **herdr tab = yaac session; herdr panes = that session's terminals** (agent +
  dev-server windows + shells — see [Terminals & in-pod tmux](#terminals--in-pod-tmux)).
- **The agent pane's herdr agent `name` = yaac `sessionId`**, and its foreground
  argv is the self-describing `yaac session attach <id>`. So a restart/delete
  **action** recovers the focused session's id by a one-shot lookup (agent name,
  or `herdr pane process-info` argv) — not a reconcile.

## Worktrees: two independent layers (not synced, by design)

yaac and herdr each have their own git-worktree machinery; this plan keeps them
**separate** and uses only yaac's. They are not synced — and structurally cannot
be the same worktree.

- **yaac owns the real working copy.** Each session gets a host worktree at
  `~/.yaac/projects/<slug>/worktrees/<sessionId>` on branch `agent/<sessionId>`
  (`addWorktree`, `src/lib/git.ts:166`; `src/server/session-create.ts:726-736`),
  hostPath-mounted into the pod at `/workspace` (`:1090`) with `.git` at
  `/repo/.git` (`:1091`). yaac reuses it on restart and `rm -rf`s it on delete.
- **These worktrees are intentionally pod-internal.** Their git pointers are
  rewritten to in-container paths (`/workspace/.git` → `gitdir: /repo/.git/
  worktrees/<id>`) and locked against pruning (`session-create.ts:431-445`), so a
  **host-side** `git` can't treat them as normal worktrees. herdr's worktree
  feature is host-side, so it could not adopt them even if we wanted.
- **herdr is a launcher only.** A yaac session shows up as a herdr **pane**
  (`yaac session attach` = a `kubectl exec` TTY), grouped under one workspace per
  *project*. herdr's native worktree feature (`herdr worktree …`,
  `~/.herdr/worktrees/<repo>/<branch-slug>`) is **not used**, and yaac sessions
  are **not** mapped onto `herdr worktree create`. Per-session branch/worktree
  isolation is real (yaac's), surfaced as separate panes, not herdr worktrees.
- **Footguns for the README:** running herdr's "New worktree" on a yaac project
  workspace spins up an unrelated *local* checkout; and although the session
  worktree is a real host dir, editing it from a local host shell while the pod
  agent edits the same files (different uid via idmapped mounts) is not a
  supported sync path.

## Terminals & in-pod tmux

A yaac session is not one terminal: inside the pod a single tmux server
(`CONTAINER_TMUX_SOCK`) runs the **agent** (first `yaac` window), any
**`initCommands` dev-server windows**, and lazily-created **scratch shells**
(`shell`, `shell-2`, …). The webapp already enumerates these
(`listSessionTerminals`, `src/server/terminals.ts`) and attaches to any via a
`target` (`agent` | `window:@<id>` | `shell:<name>`) through the PTY bridge
(`attachArgs`/`parsePtyTarget`, `src/server/pty-bridge.ts:51`).

**Mapping (clean 1:1 with herdr's hierarchy):**

| yaac | herdr |
|---|---|
| project | workspace (label = slug) |
| session | tab (label = session id/title) |
| terminal (agent / window / shell) | pane |

yaac-herdr opens one pane per terminal, naming panes `<sessionId>:<target>` so a
refresh never double-opens; the agent pane is the detected agent. You navigate
sessions with herdr's tab keys and terminals with herdr's pane-focus keys.

**Why in-pod tmux stays — herdr can't replace it.** herdr *is* a tmux
replacement, but only **host-side**: its server persists PTYs across *client*
detach and its reach ends at the host — it cannot own or supervise a process
inside a remote pod. yaac's tmux persists **in the pod**, so the agent and dev
servers outlive every client *and* the `kubectl exec` stream (a bare
`kubectl exec` child dies on SIGHUP when the stream drops). Removing in-pod tmux
would tie pod-agent liveness to a host herdr server (strictly weaker), break
yaac's own CLI/webapp attach (both attach *to tmux*), kill dev-server
persistence, and force the AGPL `herdr` binary into yaac's images — defeating the
MIT/herdr-free boundary. The two layers are **complementary**: tmux covers the
pod failure domain, herdr the host one.

**So: keep tmux, make it invisible.** "herdr, not tmux, is the multiplexer you
touch" is reached without removing tmux:
- **session→tab, terminal→pane** (above) — navigate with herdr keys, never in-pod
  tmux keys.
- **Hide tmux chrome** — attach window/grouped targets with `set status off` so a
  pane looks like a clean single terminal.
- **Bare exec for ephemeral shells** — `yaac session shell <id>` runs plain zsh
  (no tmux), so ad-hoc shells are fully native herdr panes.
- **Rebind a prefix** — herdr's default prefix is Ctrl-B, same as the in-pod
  tmux; set herdr `prefix = "ctrl+a"` (or send `Ctrl-B Ctrl-B`) so the overlap
  never bites.

**Caveats:**
- **Agent detection through the wrapper:** a pane's foreground process is
  `kubectl`/`tmux`, not `claude`, so pass `--env HERDR_AGENT=<tool>` on the agent
  pane (herdr's documented hint for wrappers that hide the real process) and
  verify detection empirically.
- **Dynamic terminals + no-reconcile:** `initCommands` windows are known at
  session start; windows/shells created later (Ctrl-B C, webapp "new shell") only
  appear after a one-shot **import/refresh** (diff `yaac session terminals --json`
  against existing panes) — consistent with the no-loop decision.

## Part 1 — yaac repo changes (generic, herdr-free)

Small, broadly useful CLI additions; the only files touched are the two command
modules + `src/cli.ts`. Reuse what's already there (`sessionCreate` already
returns the id and already has a no-attach path via `testEnv.e2eNoAttach`).

- **`src/commands/session-create.ts`** — add two options to `SessionCreateOptions`:
  - `--detach`: provision and return **without** attaching (generalize the
    existing `e2eNoAttach` branch at `:147` into a real flag; keep the test hook
    or fold it into `--detach`).
  - `--json`: print the terminal result as `{"sessionId":…,"jobName":…}` on
    **stdout**, and route progress lines to **stderr** (today `consumeSessionCreateStream`
    `console.log`s progress to stdout — gate those on `!json`/send to stderr so
    stdout stays parseable). `--json` implies non-interactive; pair with `--detach`.
- **`src/commands/session-list.ts`** — add `--json` to `SessionListOptions`: when
  set, `console.log(JSON.stringify(result.sessions))` (and the deleted variant)
  and return before the table renderers. The wire type `SessionListEntry`
  (`src/shared/types.ts:292`) is already the right shape.
- **`src/commands/session-attach.ts`** — add `--target <agent|window:@<id>|shell:<name>>`
  (default `agent`): generalize the hardcoded agent attach (`:15`) by reusing
  `parsePtyTarget` + `attachArgs` from `src/server/pty-bridge.ts`, so any pane can
  attach to a specific terminal of a session. (`yaac session shell` already gives
  a bare, non-tmux zsh.)
- **`yaac session terminals <id> --json`** (new command) — expose
  `listSessionTerminals` (`src/server/terminals.ts`) so any tool can enumerate a
  session's terminals (agent + windows + shells).
- **`src/cli.ts`** — register `--detach`/`--json` on `session create`
  (lines 158-168), `--json` on `session list` (lines 170-177), `--target` on
  `session attach` (lines 195-200), and the new `session terminals` command.
- **Tests (per `CLAUDE.md`):** e2e in `test/e2e/` for each new flag
  (`session create --detach --json` prints a parseable id and does not attach;
  `session list --json` emits valid JSON); unit in `test/unit/` for any extracted
  pure helper (e.g. a `sessionsToJson`). `pnpm lint` clean.

These flags name nothing herdr-specific — they're standard machine-readable
output, useful to any automation.

## Part 2 — `yaac-herdr` repo (separate, AGPL)

A small CLI (TypeScript/Node to match the author's stack; a POSIX shell script is
a viable MVP since it's mostly `yaac`/`herdr`/`jq` orchestration) plus a herdr
plugin manifest. Suggested layout: `bin/` (the CLI), `plugin/herdr-plugin.toml`,
`README.md`, `LICENSE` (AGPL-3.0-or-later).

**Thin `herdr` CLI wrapper** (one module; the only place herdr is referenced):
- `ensureWorkspace(slug)` → find by label in `herdr workspace list --json`, else
  `herdr workspace create --label <slug> --no-focus`; returns the workspace id.
- `startAgent({id, target, tool, workspaceId})` → `herdr agent start
  <id>:<target> --workspace <ws> --env YAAC_SESSION_ID=<id>
  --env HERDR_AGENT=<tool> -- yaac session attach <id> --target <target>`.
  `HERDR_AGENT` is herdr's hint so screen detection picks the right manifest
  despite the `kubectl`/`tmux` wrapper hiding the real process.
- `renameSelf(id)` → `herdr agent rename $HERDR_PANE_ID <id>`.
- `closePane(paneId)` → `herdr pane close`.
- `focusedSessionId()` → from `HERDR_PLUGIN_CONTEXT_JSON` resolve the focused
  agent's name, falling back to parsing `yaac session attach <id>` out of
  `herdr pane process-info --json`.

**`yaac-herdr` verbs** (each maps to a plugin action/pane):
- `new` — opened as a herdr **pane**. Resolve project from the focused
  workspace's label (the slug), else show a picker over `yaac project list`;
  resolve tool (flag or default). Then:
  `id=$(yaac session create <project> -t <tool> --detach --json | …sessionId)`,
  `renameSelf(id)`, then `exec yaac session attach <id>` so the pane shows the
  live agent and its argv carries the id. (Create+attach split via `--detach` so
  yaac-herdr controls naming; provisioning progress shows on stderr in the pane.)
- `restart` — action on the focused pane: `id = focusedSessionId()`,
  `yaac session restart <id>`, then re-open the pane (`closePane` the old +
  `startAgent` in the same workspace), since restart recreates the Job and the old
  attach has exited. (Alternative: a self-reattaching pane wrapper; pane
  replacement is simpler for v1.)
- `delete` — action: `id = focusedSessionId()`, `yaac session delete <id>`,
  `closePane(focused)`.
- `import` / refresh *(optional, explicitly one-shot — not a loop)* — `yaac
  session list --json` → for each session `ensureWorkspace(slug)` and open its
  terminals as panes (`yaac session terminals <id> --json` → one `startAgent` per
  `<id>:<target>`), skipping panes that already exist. Run on demand to adopt
  sessions (or new windows/shells) created outside herdr.

**herdr plugin manifest** (`plugin/herdr-plugin.toml`):

```toml
id = "yaac"
name = "yaac"
version = "0.1.0"
min_herdr_version = "<pin to the tested herdr release>"
platforms = ["linux", "macos"]

[[panes]]
id = "new"
title = "New yaac session"
placement = "overlay"
command = ["yaac-herdr", "new"]

[[actions]]
id = "restart"
title = "Restart yaac session"
contexts = ["agent"]
command = ["yaac-herdr", "restart"]

[[actions]]
id = "delete"
title = "Delete yaac session"
contexts = ["agent"]
command = ["yaac-herdr", "delete"]

[[actions]]                      # optional one-shot adoption
id = "import"
title = "Import existing yaac sessions"
contexts = ["workspace"]
command = ["yaac-herdr", "import"]
```

README documents install (`herdr plugin link <repo>/plugin`) and suggested
keybinds (`[[keys.command]] type = "plugin_action" command = "yaac.restart"`, and
a `plugin pane open` binding for `new`).

**Tests (in the yaac-herdr repo, its own setup):** unit-test the pure bits
(id parsing from argv, project resolution) against fake `yaac`/`herdr` on `PATH`;
one integration smoke against a stub `herdr` + real `yaac`.

## Licensing rationale

- yaac stays **MIT** and **herdr-free**: only generic `--json`/`--detach` flags,
  no herdr names, no AGPL code, no plugin.
- `yaac-herdr` is a **separate repo, AGPL-3.0-or-later**. It integrates purely by
  **invoking the `yaac` and `herdr` CLIs as separate processes** over their
  documented interfaces — mere use/aggregation, not linking — so it is not a
  derivative work of either binary. AGPL applies to yaac-herdr's own code and the
  herdr plugin it ships. *(Not legal advice; this is the standard separate-process
  pattern for keeping copyleft and permissive code apart.)*

## Verification (same machine)

1. **yaac repo:** implement the flags; `pnpm lint`; `pnpm build && npm install -g
   .`. Confirm `yaac session create <p> -t claude --detach --json` prints a
   parseable `{sessionId,jobName}` and does **not** attach; `yaac session list
   --json` is valid JSON.
2. **yaac-herdr repo:** build/install `yaac-herdr` on `PATH`;
   `herdr plugin link "$PWD/plugin"`; start herdr and bind keys.
3. Open the **New yaac session** pane → pick project/tool → watch provisioning,
   then the live Claude TUI; confirm herdr shows `working`/`blocked`/`done`
   (`herdr agent list`) and the agent is named the session id.
4. Fire **restart** and **delete** on the focused pane; confirm the yaac session
   restarts (re-attaches) / is deleted and its pane closes.
5. Create a session via `yaac session create <p>` directly, then run **import**;
   confirm a workspace + attached pane appear (one-shot, no further syncing).

## Out of scope

- No reconcile/bridge process (per the user); herdr is a launcher only.
- No yaac server/HTTP/auth changes; no herdr references in the yaac repo.
- No remote topology (would need the unimplemented `plans/remote-server-hosting.md`
  + attach over the server's `/pty/attach` WebSocket).
- No `herdr pane report-agent` state pushing (screen detection already covers all
  three tools).

## Risks / open questions

- **`--json` stdout cleanliness:** ensure create's progress goes to stderr so
  stdout is pure JSON; verify the NDJSON consumer (`consumeSessionCreateStream`)
  is gated correctly.
- **herdr CLI `--json` shapes / version:** confirm fields for `workspace
  list/create`, `agent start/rename/list`, `pane close/process-info` against the
  installed herdr; pin `min_herdr_version`. Isolated to the one wrapper module.
- **Restart UX:** pane replacement vs. a self-reattaching pane wrapper — pick one
  (plan defaults to replacement).
- **tmux detach cleanliness:** closing a herdr pane should not leak an attached
  tmux client in the pod (the webapp bridge sends `C-b d` first,
  `src/server/pty-bridge.ts:171`); verify, and detach-before-close if needed.
