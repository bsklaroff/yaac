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

## 2 — Collaboration (high priority)

Shift beyond the current single-user, 127.0.0.1-only model so a team can
work a shared fleet of agents. Needs real design around identity, remote
access, and security — but it's a primary direction, not an afterthought.

- ⬜ Shared / observable sessions: watch a teammate's agent terminal live
  (the PTY bridge already tees one terminal to multiple clients)
- ⬜ Presence + handoff: see who's attached; take over a session
- ⬜ Comments / annotations on sessions and on diffs
- ⬜ Team projects and a shared credential vault
- ⬜ Remote access: secure tunnel or a hosted control plane, with real auth
  and identity — supersedes the loopback-only stance

---

## 3 — Workflow: Plan / Build / Review

Adapt code-design's modes to agent orchestration. A unit of work moves
through three modes, switched from a top bar:

- ⬜ **Plan** — define the task *before* launching an agent: prompt/spec,
  scope (repo + mounted dirs), tool, constraints, acceptance notes. Save
  and reuse plans; queue several.
- ⬜ **Build** — the active agent run (today's terminal), enriched with
  status, prompt history, forwarded ports, and logs.
- ⬜ **Review** — inspect what the agent produced: worktree **diff** viewer +
  file browser, accept / iterate / discard, draft a commit or PR, push.

---

## 4 — Optional LLM features

_Placeholder — scope TBD._

---

## Cross-cutting notes

- **Design system** lives on the `claude/base-ui` branch (tokens, Base UI,
  Central Icons, rail) and feeds every UI item above.
- **Central Icons** is a gated paid dependency — installing yaac needs that
  registry's auth; resolve (vendor the used icons, or gate) before yaac is
  broadly installable.
- The webapp is a presentation layer over the daemon; UI features that need
  host actions (open-editor, diffs) land as daemon endpoints first.
