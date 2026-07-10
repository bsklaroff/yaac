/**
 * Wire protocol for the auth-agent relay: the ops the server sends down the
 * single outbound WebSocket to the auth server ("agent") running on the
 * user's machine. Kept here in shared so both the server hub
 * (`@yaac/server/auth-agent`) and the auth-daemon's connection
 * (`@/auth-daemon/connection`) speak the same shapes without importing each
 * other.
 *
 * Deliberately minimal — no request/response correlation:
 *  - down (server → agent):  {op:'start'|'input'|'cancel', id, ...}
 *  - up   (agent → server):  {op:'view', kind, view} on every change
 */
export type AgentKind = 'login' | 'install'
export type AgentTool2 = 'claude' | 'codex'

export type AgentOp =
  | { op: 'start'; id: string; kind: AgentKind; tool: AgentTool2 }
  | { op: 'input'; id: string; text: string }
  | { op: 'cancel'; id: string; kind: AgentKind }
