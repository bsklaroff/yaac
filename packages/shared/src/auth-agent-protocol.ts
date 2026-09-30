/**
 * Wire protocol between the server (`domain/auth/agent.ts`) and the auth
 * server ("agent") on the user's machine (`auth-daemon/src/connection.ts`),
 * over the agent's one WebSocket. No request/response correlation:
 *  - server → agent: {op:'start'|'input'|'cancel', id, ...}
 *  - agent → server: {op:'view', kind, view} on every change
 */
export type AgentKind = 'login' | 'install'
export type AgentTool2 = 'claude' | 'codex'

export type AgentOp =
  | { op: 'start'; id: string; kind: AgentKind; tool: AgentTool2 }
  | { op: 'input'; id: string; text: string }
  | { op: 'cancel'; id: string; kind: AgentKind }
