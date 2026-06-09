# yaac — product roadmap

yaac is a local-first manager for **fleets of coding agents** running in
sandboxed containers, driven from a CLI and a webapp over one daemon. This
roadmap tracks the arc from today's operator tool toward a collaborative,
workflow-driven agent platform.

Legend: ✅ shipped · 🚧 in progress · ⬜ planned

---

## 0 — Foundation

The daemon-backed webapp and its plumbing.

- ✅ Daemon HTTP API; CLI is a thin client over it
- ✅ Webapp auth: one-time bootstrap code → HttpOnly cookie; Host-header +
  CORS guards (DNS-rebind safe); sessions persist across daemon restarts
- ✅ Events WebSocket (live state snapshot, no polling)
- ✅ PTY bridge + embedded xterm.js terminal (attach to a session's tmux)
- ✅ `yaac open` — one command: starts the daemon, opens the browser authed
- ✅ Design system: Base UI primitives + design tokens (ported from
  code-design) + Central Icons, all centralized
- ✅ Projects rail + project-scoped session sidebar
- ✅ Create a session from the webapp (Base UI dialog, streamed progress)

---

## 1 — Operator core (near term)

Make managing many agents fast and legible.

- ⬜ **Triage: "next waiting →"** — the in-app `session stream`: jump to the
  next session awaiting input, across projects. The single most
  yaac-defining interaction.
- ⬜ Attention model: a reliable "needs me" signal (waiting / blocked host /
  exited) surfaced on the rail badge and session rows
- ⬜ Session row richness: tool glyph, last-activity, blocked-host flag,
  prompt preview
- ⬜ Terminal tabs per session: attach / shell / new-window (needs the
  daemon shell + window PTY endpoints)
- ⬜ Session lifecycle UI: delete (ConfirmDialog), restart, open worktree in
  editor
- ⬜ New-project flow (rail `+`) and project removal
- ⬜ Settings → CLI parity: GitHub tokens, Claude/Codex OAuth, default tool,
  per-project config editor (Monaco), credentials listing
- ⬜ Filtering / search and strong empty + onboarding + reconnecting states

---

## 2 — Workflow: Plan / Build / Review (mid term)

Adapt code-design's modes to agent orchestration. A unit of work moves
through three modes, switched from a top bar:

- ⬜ **Plan** — define the task *before* launching an agent: prompt/spec,
  scope (repo + mounted dirs), tool, constraints, acceptance notes. Save
  and reuse plans; queue several.
- ⬜ **Build** — the active agent run (today's terminal), enriched with
  status, prompt history, forwarded ports, and logs.
- ⬜ **Review** — inspect what the agent produced: worktree **diff** viewer +
  file browser, accept / iterate / discard, draft a commit or PR, push.
  Hooks into the existing `AttachOutcome` (detached / closed_blank /
  closed_prompted).

---

## 3 — Optional LLM features (additive, bring-your-own-key)

All opt-in and gated behind a toggle / user-supplied key, so the core stays
local-first with no mandatory cloud dependency.

- ⬜ Auto-title sessions; summarize what an agent did
- ⬜ Generate or refine the **Plan** prompt from a one-line description
- ⬜ Triage assistant: rank which sessions need attention; summarize blockers
- ⬜ Review helpers: explain-the-diff, draft the PR description / commit msg
- ⬜ Semantic search across sessions and transcripts
- ⬜ Fleet digest: "what changed / what's stuck" across all running agents

---

## 4 — Collaboration (later — architectural shift)

Moves beyond the current single-user, 127.0.0.1-only model. Each step is a
*non-goal today* and needs real design around identity, remote access, and
security.

- ⬜ Shared / observable sessions: watch a teammate's agent terminal live
  (the PTY bridge already tees one terminal to multiple clients)
- ⬜ Presence + handoff: see who's attached; take over a session
- ⬜ Comments / annotations on sessions and on diffs (in Review)
- ⬜ Team projects and a shared credential vault
- ⬜ Remote access: secure tunnel or a hosted control plane, with real auth
  and identity — supersedes the loopback-only stance

---

## 5 — Productization (later)

- ⬜ Electron (or Tauri) desktop shell: supervises the daemon, opens the UI,
  makes auth invisible, ships signed installers + auto-update
- ⬜ Tray / menu-bar presence; auto-start the daemon on login
- ⬜ API hardening: `/v1` versioning, granular per-entity event types,
  migrate CLI `attach` / `shell` / `stream` onto the WS bridge

---

## Cross-cutting notes

- **Design system** lives on the `claude/base-ui` branch (tokens, Base UI,
  Central Icons, rail) and feeds every UI item above.
- **Central Icons** is a gated paid dependency — installing yaac needs that
  registry's auth; resolve (vendor the used icons, or gate) before yaac is
  broadly installable.
- The webapp is a presentation layer over the daemon; new UI features that
  need host actions (open-editor, diffs) land as daemon endpoints first.
