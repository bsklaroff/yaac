# Agent UI: a structured ACP pane for agent sessions

## Context

Today the only way to interact with a session's agent is the terminal: the
interactive `claude` TUI runs under tmux in the pod, xterm.js renders raw PTY
bytes, "send a prompt" is tmux `paste-buffer` keystroke simulation
(`buildPromptPasteCmd`), and agent status is inferred from a title glyph
(`classifyClaudeTitle`). This plan replaces the terminal as the *primary*
agent interface with a structured React pane — chat timeline, tool-call
cards, permission prompts, a real send box — while keeping the PTY path for
shells, `native` attach, the CLI, and non-ACP sessions.

**Decision: build on the Agent Client Protocol (ACP,
agentclientprotocol.com) using the `claude-agent-acp` adapter** (wraps the
official Claude Agent SDK; stdio JSON-RPC 2.0) rather than driving the
Agent SDK directly or tailing transcript JSONL. What ACP buys:

- A versioned, typed protocol designed for exactly this client role —
  streaming message chunks, tool calls with live updates, plan reporting,
  permission requests, config options, cancellation — maintained outside
  yaac.
- Agent portability: Gemini CLI, Copilot CLI, and Codex CLI speak ACP
  natively, and adapters exist for others. The pane is protocol-level; a
  second tool is a launch-command change, not a new UI.
- The client SDK (`@agentclientprotocol/sdk`) is Node-only, which matches
  the architecture anyway: the server is the ACP client, the browser talks
  to the server.

The adapter and SDK versions are pinned at integration time (exact-version
per repo convention); the host records the capabilities each adapter
negotiates and codes to that surface, ignoring unknown update kinds and
config options, so protocol evolution degrades gracefully instead of
breaking the pane.

## Auth is an external variable, not an architecture input

Whether the Claude Agent SDK (and therefore the adapter) accepts the
project's credentials is Anthropic policy. As of mid-2026, subscription
auth works with the SDK — Agent SDK, `claude -p`, and third-party app
usage draw from Claude subscription limits (support.claude.com article
15036540) — but the policy has shifted during 2026 and may shift again.
yaac credentials are also install/project level (the host-mounted
`~/.claude` and config env), not per-session — so the plan encodes **no
auth-kind gating anywhere**:

- The ACP host attempts the adapter with whatever credentials the project
  has. Auth is validated empirically at every adapter (re)spawn:
  `initialize`, then the `session/new`/`session/load` attempt — an
  `auth_required` result (or an auth-classified prompt failure) is the
  fallback signal. yaac never calls ACP `authenticate`: that is an
  interactive login flow selected from the advertised `authMethods`, not
  a credential health check, and yaac implements no login flow.
- If auth fails at session create, creation falls back to a standard
  terminal (TUI) session and says why. If it fails on a later respawn
  (credentials changed after create), the pane shows a clear degraded
  state with a restart-as-terminal-session action; nothing silently
  reuses stale credentials.
- Policy references live in this section only; no other part of the design
  depends on which auth kinds currently work.

## Architecture

```
browser ── WS /session/:id/agent-acp ── server AcpSessionHost ── relay ctrl
                (JSON events, replay+live)    (ACP client, one     stream ──►
                                               per ACP session)    adapter in pod
                                                                   (stdio JSON-RPC)
```

### In-pod: the adapter over the existing relay

The `claude-agent-acp` adapter is baked into the tools image
(`dockerfiles/Dockerfile.tools`, npm-installed at a pinned version — the
image content hash retags on bump). No streamd, proxy, port, token, or
network-policy changes: the server launches it through the existing streamd
`ctrl` kind (spawn argv with piped stdio, raw splice — the same mechanism
as the tmux control-mode status stream). ACP frames are newline-delimited
JSON-RPC over that splice. The adapter's stderr is redirected to a bounded
in-pod log file; on spawn failure or unexpected exit the host reads it via
`sessionExec` and surfaces the tail in the pane, so version/auth/startup
failures are diagnosable (the `ctrl` splice itself carries only stdout).

`ctrl` semantics mean socket close ⇔ adapter process kill: a server restart
or relay drop aborts the in-flight turn. Accepted — the SDK persists the
session transcript continuously (to the host-mounted `~/.claude`, same as
today), and the host reconnects with `session/load`. The aborted turn is
marked **interrupted** in the timeline and is never auto-retried: its tool
calls may already have run, so re-prompting is the user's call.

ACP sessions still get their tmux server, but their initial window is a
**real shell**, not the tool-named keepalive that `buildAgentCmd` normally
respawns. That keeps every tmux consumer coherent: CLI `native` attach
(used by `session attach`/`create`/`restart`) lands in a working shell
rather than `sleep infinity`, initCommands windows work unchanged, and
scratch shells behave as in any session. Terminals in an ACP session are
shells only — they cannot drive the adapter's SDK session, so terminal
access is *not* an escape hatch for agent-level operations (see protocol
gaps below). `initialPrompt`, scheduled, and background sessions route
through `AcpSessionHost.prompt()` after `session/new` instead of the tmux
paste path. `ANTHROPIC_API_KEY`/credentials reach the pod through the
existing mounts and config env passthrough; the adapter's API traffic
rides the same proxy/egress path as the CLI's.

### Server: one ACP host per session

A new `features/agent-acp/` module, lifecycle-managed like
`SessionStatusWatcher` (informer-synced, backoff respawn):

- `AcpSessionHost` owns the ctrl stream and the `@agentclientprotocol/sdk`
  client over it: `initialize` advertising only what yaac supports (`fs`
  and `terminal` are omitted entirely — unsupported capabilities are
  omitted, not set false; yaac has no editor buffers and the SDK executes
  in-pod), then `session/new` or `session/load`.
- The ACP session id ↔ yaac session mapping persists in a new
  `acp_session_meta` table (Drizzle migration; precedent:
  `opencode_session_meta`). The adapter generates its own SDK session id
  (it does not adopt the yaac id the way `buildAgentCmd` does), so
  everything that touches the SDK transcript resolves through this
  mapping: the restart-as-terminal action resumes with `claude --resume
  <acp session id>` — the generic restart path, which passes the yaac id,
  would resume the wrong (empty) transcript — and first-message/title
  extraction reads the transcript file under the ACP id.
- **Event log with load epochs.** ACP `session/load` replays the entire
  conversation as `session/update` notifications before its response
  returns, so a naive append log would duplicate history on every
  reconnect. Each (re)connect starts a new **generation**: live fan-out is
  suspended, the canonical log is rebuilt from the load replay, and the
  host atomically publishes a `reset` snapshot followed by sequenced live
  events. Browser events carry `{gen, seq}`; a client discards anything
  from a stale generation. Bounding drops raw deltas, not the timeline:
  the log keeps a compact materialized snapshot (merged chunks, collapsed
  tool cards with truncated payloads) plus recent raw events, so a
  same-generation reconnect always gets the full timeline in compact
  form. Payloads truncated out of the snapshot are simply unavailable
  until the `session/load` of the next adapter respawn — the host never
  reloads the adapter mid-turn to recover them.
- **Commands are request/ack.** Browser→server `prompt`, `cancel`,
  `set_config_option` (the preferred surface — session config options
  supersede legacy modes; a modes fallback covers agents that only expose
  modes), and permission responses all carry client request ids and are
  acked. Acks alone don't make delivery reconnect-safe (the socket can
  die between `session/prompt` and the ack), so the host keeps a bounded
  per-session ledger of processed command ids and outcomes keyed by
  client identity and replays the cached ack on a duplicate — a client
  that reconnects after a lost ack re-asks safely instead of double-
  prompting. The ledger is in-memory: after a server restart, in-flight
  commands settle as an explicit `unknown` outcome, and the client never
  auto-retries a prompt/cancel/config mutation on `unknown` — the
  timeline shows whether the turn actually ran, and the user decides.
- **Permissions follow the ACP contract.** A `session/request_permission`
  carries agent-defined options; the pane renders those options verbatim
  and the response selects one of the supplied `optionId`s (or reports
  `cancelled`) — there is no yaac-invented approve/deny. Requests fan out
  to attached clients correlated by request id; the first response wins
  and later ones are acked as stale. Normal permissiveness is governed by
  the agent's own config options (e.g. accept-edits), not a yaac side
  channel. **Every permission request starts a deadline** — client
  attachment lengthens it but never disables it (a backgrounded browser
  can hold its socket open indefinitely without answering). At the
  deadline the host selects an agent-offered reject-kind option; ACP
  option kinds are allow/reject only, so if no reject option is offered
  it sends `session/cancel` and settles the request with the `cancelled`
  outcome. It never invents an option and never auto-selects an allow.
- **Status.** The shared session-list contract stays `running | waiting`
  (sidebar unread state, chime, tray, and next-waiting all key on
  `waiting`). ACP sessions additionally expose a detailed activity state
  (idle / thinking / tool running / awaiting permission / interrupted) as
  a new shared type with runtime validation in `@yaac/shared`. Mapping:
  awaiting-permission and idle-after-turn → `waiting`; thinking/tool
  execution → `running`. Replay generations recompute state at the
  live handoff without emitting spurious attention transitions. The
  glyph-based status watcher never starts for ACP sessions (from phase 1 —
  there is no agent pane for it to probe, and it would loop through its
  recovery path).

The browser-facing WS is a thin JSON event stream, not raw ACP — the
server multiplexes many browsers onto one ACP connection and owns replay,
so ACP's single-client stdio model never leaks upward.

### Frontend: a pane, not a rewrite

Precedent: `SessionChanges` — a structured React pane living in the tiling
layout via a special target (`isSpecialPane()` in `SessionView.tsx`). The
agent pane is the same shape: a new target (`agent-acp`), a render branch,
and an API module. For ACP sessions it replaces the `agent` terminal target
as the default pane; shell terminals remain available as tabs beside it.

`AgentPane` renders the event log: accumulated `agent_message_chunk`
markdown, tool-call cards keyed by `toolCallId` updating in place, the
current plan as replace-in-full **status display** (ACP plans are
informational — there is no accept/reject response; any plan-related
approval arrives separately as a permission request and is rendered as
one), permission prompts listing the agent-supplied options, a config
panel driven by the negotiated config options, a prompt composer, and a
cancel control. All agent-originated content — markdown, tool inputs and
outputs, links, diffs — is untrusted: rendered sanitized (no raw HTML),
links are inert-by-default, and tool output is displayed as text.
Reconnect uses the existing `lib/reconnect.ts` backoff plus the
generation/sequence protocol above.

## Protocol surface notes

- **Usage/cost**: the stable `usage_update` session update carries the
  current context (`used`/`size`, required) and optional cumulative
  `cost`; the host consumes it when emitted — the pinned Claude adapter
  emits the standard update — and the pane surfaces context pressure and
  cost from it. Transcript-JSONL merging remains only as a fallback for
  an older pinned adapter without the update.
- **Slash commands**: the pane offers the agent's advertised
  `available_commands_update` commands; `/compact` and friends go through
  `session/prompt` like any prompt (the adapter supports compaction and
  reports its status).
- **Subagent attribution** rides an adapter extension
  (`_meta.claudeCode.parentToolUseId`); render nested tool calls under
  their parent when present, flat otherwise.

## Phasing

1. **Transport + host**: adapter in the tools image; `AcpSessionHost` +
   ctrl-stream client with auth-failure fallback; generation/sequence
   event log; `session/new`/`load`/`prompt`/`cancel`; WS route;
   `acp_session_meta` migration; create-flow interface selection with the
   shell initial window; status-watcher exclusion; CLI behavior for ACP
   sessions (create prints the webapp URL instead of auto-attaching to an
   agent window; `native` attach lands in the shell).
2. **Pane**: `agent-acp` target, timeline rendering (chunks, tool cards,
   interrupted markers), composer, cancel, sanitized rendering. Status
   mapping into the existing `running|waiting` contract plus the detailed
   activity state.
3. **Interaction depth**: permission prompts (agent-supplied options,
   deadline policy), plan display, config-options panel, image input,
   `usage_update` surfacing, slash-command palette.
4. **Second agent**: wire one natively-ACP tool (e.g. Gemini CLI `--acp`)
   through the same host to prove the pane is agent-agnostic.

## Testing

- Unit (`packages/server/test/features/agent-acp/`): ACP client framing
  against a scripted fake adapter (initialize/capability negotiation,
  generation reset + replay dedup, fan-out, permission optionId flow and
  deadline policy, command acks with lost-ack replay and unknown-outcome
  settlement, auth-failure fallback). Frontend:
  timeline reducer (chunk accumulation, tool-card updates, stale-
  generation discard), composer, permission UI, sanitization.
- E2e (`test/e2e/`): create an ACP-mode session against a mock
  Anthropic-API endpoint (egress mock precedent exists in the
  session-create e2e family), drive a prompt through the WS, assert
  streamed updates, cancel, `session/load` resume across a host restart
  with no duplicated history, a lost-ack reconnect that does not
  double-prompt, and an ACP→terminal fallback restart that resumes the
  mapped transcript with history preserved. Any new CLI flag (e.g. `yaac
  session create --interface acp`) gets an e2e-cli test per repo rule.
- Adapter image bump = tools-image content-hash change; global setup
  rebuilds automatically; tests pass `requirePrebuilt: true` as usual.

## Out of scope (deliberate)

- Advertising ACP `fs`/`terminal` client capabilities (no editor buffers
  to serve; the SDK executes in-pod).
- Server-side message persistence beyond the bounded in-memory log — the
  SDK's own transcript plus `session/load` is the source of truth.
- Replacing the PTY path, CLI attach, or the tmux-based session plumbing.
- A transcript-mirror pane for TUI sessions (a separate possible feature;
  nothing here depends on it).
