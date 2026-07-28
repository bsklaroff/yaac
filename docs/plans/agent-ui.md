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
agentclientprotocol.com) using `@agentclientprotocol/claude-agent-acp`**
(wraps the official Claude Agent SDK; stdio JSON-RPC 2.0) rather than
driving the Agent SDK directly or tailing transcript JSONL. What ACP buys:

- A versioned, typed protocol designed for exactly this client role —
  streaming message chunks, tool calls with live updates, plan proposals,
  permission requests, modes, cancellation — maintained outside yaac.
- Agent portability: Gemini CLI, Copilot CLI, and Codex CLI speak ACP
  natively, and adapters exist for others. The pane is protocol-level; a
  second tool is a launch-command change, not a new UI.
- The client SDK (`@agentclientprotocol/sdk`) is Node-only, which matches
  the architecture anyway: the server is the ACP client, the browser talks
  to the server.

## The auth constraint (governs everything)

The adapter uses the Claude Agent SDK, and per Anthropic's terms (Feb 2026)
subscription OAuth (Pro/Max, `claude setup-token`) may not be used with the
SDK or third-party harnesses — only `ANTHROPIC_API_KEY` (or
Bedrock/Vertex/Foundry). Subscription tokens are also blocked server-side.
Running the *interactive* `claude` TUI with the user's own login — what yaac
does today — remains the sanctioned consumer use.

So the ACP pane is **auth-gated**: a session runs in ACP mode only when its
credentials are an API key. Subscription-authed sessions keep the terminal
interface unchanged. This is a per-session capability decided at create
time, not a fork of the product.

## Architecture

```
browser ── WS /session/:id/agent-acp ── server AcpSessionHost ── relay ctrl
                (JSON events, replay+live)    (ACP client, one     stream ──►
                                               per ACP session)    adapter in pod
                                                                   (stdio JSON-RPC)
```

### In-pod: the adapter over the existing relay

`@agentclientprotocol/claude-agent-acp` is baked into the tools image
(`dockerfiles/Dockerfile.tools`, npm-installed at a pinned version — the
image content hash retags on bump). No streamd, proxy, port, token, or
network-policy changes: the server launches it through the existing streamd
`ctrl` kind (spawn argv with piped stdio, raw splice — the same mechanism
as the tmux control-mode status stream). ACP frames are newline-delimited
JSON-RPC over that splice.

`ctrl` semantics mean socket close ⇔ adapter process kill: a server restart
or relay drop aborts the in-flight turn. Accepted — the SDK persists the
session transcript continuously (to the host-mounted `~/.claude`, same as
today), and the host reconnects with `session/load`, which replays history
and resumes the conversation. An interrupted turn is re-promptable, not
lost work.

ACP-mode sessions still get their tmux server (shells, initCommands
dev-server windows, `native` attach all keep working); the agent window is
simply never spawned — `buildAgentCmd` is bypassed and the adapter is
launched on demand instead. `ANTHROPIC_API_KEY` reaches the pod through the
existing config env passthrough; the adapter's API traffic rides the same
proxy/egress path as the CLI's.

### Server: one ACP host per session

A new `features/agent-acp/` module, lifecycle-managed like
`SessionStatusWatcher` (informer-synced, backoff respawn):

- `AcpSessionHost` owns the ctrl stream and the `@agentclientprotocol/sdk`
  client over it: `initialize` (advertise `fs: false` — yaac has no editor
  buffers; the SDK does its own file I/O in-pod — and `terminal: false`
  initially), then `session/new` or `session/load`.
- The ACP session id ↔ yaac session mapping persists in a new
  `acp_session_meta` table (Drizzle migration; precedent:
  `opencode_session_meta`).
- Every `session/update` notification is appended to an in-memory
  per-session event log and fanned out to attached WS clients; a client
  connecting mid-session gets a replay of the log (full history beyond the
  current server run comes from `session/load`'s replay).
- `session/request_permission` fans out to attached clients; first response
  wins; a configurable default (per-session permission mode: auto-accept /
  accept-edits / ask) answers when no client is attached, so an unattended
  agent never hangs on approval.
- Status: ACP updates drive `status-store.ts` directly with a richer enum
  (idle / thinking / running tool / awaiting permission / awaiting input).
  The glyph-based watcher simply doesn't start for ACP sessions. The
  sidebar, tray, chime, and "next waiting" triage all upgrade for free.

The browser-facing WS is a thin JSON event stream (`replay` + live updates
+ client→server `prompt` / `cancel` / `permission_response` / `set_mode`),
not raw ACP — the server multiplexes many browsers onto one ACP connection
and owns replay, so ACP's single-client stdio model never leaks upward.

### Frontend: a pane, not a rewrite

Precedent: `SessionChanges` — a structured React pane living in the tiling
layout via a special target (`isSpecialPane()` in `SessionView.tsx`). The
agent pane is the same shape: a new target (`agent-acp`), a render branch,
and an API module. For ACP sessions it replaces the `agent` terminal target
as the default pane; terminals remain available as tabs beside it.

`AgentPane` renders the event log: accumulated `agent_message_chunk`
markdown, tool-call cards keyed by `toolCallId` updating in place from
`tool_call_update`, plan proposals with accept/reject, permission prompts
with approve/deny buttons, a mode switcher (`current_mode_update` /
available modes), a prompt composer, and a cancel control
(`session/cancel`). Reconnect uses the existing `lib/reconnect.ts` backoff.

## Known protocol gaps (accepted, with mitigations)

- **No token/cost data in ACP updates.** The SDK still writes the transcript
  JSONL to the host-mounted `~/.claude`, so per-turn usage can be read from
  there and merged into the timeline server-side if wanted — additive later.
- **Slash-command coverage is partial** in the adapter (`/compact` notably
  unsupported). The escape hatch is deliberate: these sessions still have
  terminals.
- **Subagent attribution** rides an adapter extension
  (`_meta.claudeCode.parentToolUseId`); render nested tool calls under
  their parent when present, flat otherwise.

## Phasing

1. **Transport + host**: adapter in the tools image; `AcpSessionHost` +
   ctrl-stream client; `session/new`/`load`/`prompt`/`cancel`; event log +
   WS route; `acp_session_meta` migration; create-flow flag (API-key
   sessions only) that skips the agent tmux window.
2. **Pane**: `agent-acp` target, timeline rendering (chunks, tool cards),
   composer, cancel. Status-store integration and the richer status enum.
3. **Interaction depth**: permission prompts UI + per-session permission
   mode, plan accept/reject, mode switcher, image input (ACP supports it),
   usage merge from transcript JSONL.
4. **Second agent**: wire one natively-ACP tool (e.g. Gemini CLI `--acp`)
   through the same host to prove the pane is agent-agnostic.

## Testing

- Unit (`packages/server/test/features/agent-acp/`): ACP client framing
  against a scripted fake adapter (initialize/capability negotiation,
  update fan-out, replay, permission default policy, reconnect/`load`).
  Frontend: timeline reducer (chunk accumulation, tool-card updates,
  out-of-order `tool_call_update`), composer, permission UI.
- E2e (`test/e2e/`): create an ACP-mode session against a mock
  Anthropic-API endpoint (egress mock precedent exists in the
  session-create e2e family), drive a prompt through the WS, assert
  streamed updates, cancel, and `session/load` resume across a host
  restart. Any new CLI flag (e.g. `yaac session create --interface acp`)
  gets an e2e-cli test per repo rule.
- Adapter image bump = tools-image content-hash change; global setup
  rebuilds automatically; tests pass `requirePrebuilt: true` as usual.

## Out of scope (deliberate)

- Subscription-auth sessions in ACP mode — prohibited by Anthropic's terms;
  they keep the terminal interface. (A read-only transcript-mirror pane for
  those sessions is possible separately, but is not this plan.)
- Advertising ACP `fs`/`terminal` client capabilities (no editor buffers to
  serve; the SDK executes in-pod).
- Server-side message persistence beyond the in-memory log — the SDK's own
  transcript plus `session/load` is the source of truth.
- Replacing the PTY path, CLI attach, or the tmux-based session plumbing.
