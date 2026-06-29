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
  code-design) + centralized icons, all centralized
- ✅ Projects rail + project-scoped session sidebar
- ✅ Create a session from the webapp (Base UI dialog, streamed progress)

---

## 1 — Operator core (near term)

Make managing many agents fast and legible.

- 🚧 **Triage: "next waiting →"** — jump to the next session awaiting input,
  across projects. The single most yaac-defining interaction. CLI `session
  stream` shipped; the in-app cross-project jump is still pending (today the
  webapp auto-selects the first waiting session and flags waiting projects on
  the rail).
- ✅ Attention model: a reliable "needs me" signal (waiting / blocked host /
  exited) surfaced on the rail badge and session rows
- ✅ Session row richness: tool label, last-activity, blocked-host flag,
  prompt preview
- ✅ Terminal tabs per session: attach / shell / new-window — now exceeds the
  original scope with a tiling split-pane workspace (drag-to-rearrange,
  resizable dividers) plus a tabs mode, over the daemon shell + window PTY
  endpoints
- 🚧 Session lifecycle UI: delete (ConfirmDialog), restart, and rename
  shipped; open worktree in editor still pending
- ✅ New-project flow (rail `+`) and project removal
- 🚧 Settings → CLI parity: default tool, credentials listing, and GitHub
  token add shipped; Claude/Codex OAuth UI and the per-project config editor
  (Monaco) still pending
- 🚧 States: strong empty + onboarding + reconnecting states shipped;
  filtering / search still pending

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

- **Design system** is merged into `main` (`src/frontend/`): tokens, Base UI,
  centralized icons, and the rail all feed every UI item above.
- **Icons**: the icon blocker is resolved — yaac ships the free,
  open-source `lucide-react` set as its centralized icons, so installing it
  needs no gated-registry auth. The paid Central Icons variant (round-filled,
  real brand glyphs) is parked on the `claude/central-icons-ref` branch for
  reference.
- The webapp is a presentation layer over the daemon; UI features that need
  host actions (open-editor, diffs) land as daemon endpoints first.
