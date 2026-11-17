/**
 * Wire protocol between the server (`domain/auth/tool-login.ts`) and the
 * auth daemon on the user's machine (`auth-daemon/src/connection.ts`), over
 * the daemon's one WebSocket. The server runs every sign-in; the daemon only
 * catches a vendor's redirect to a loopback address on that machine.
 *  - server → daemon: `listen` for the redirect of the authorize URL `url`
 *    (its `redirect_uri` names the port), or `cancel` that listener.
 *  - daemon → server: that it is `listening` (the server answers the start
 *    only then); the `callback` it caught; that it could not listen (the
 *    server carries on without it); or that the redirect brought no code
 *    (the sign-in fails).
 * The socket's path (`/api/agent/sign-in`) names this protocol, so a daemon
 * and a server built for different ones never pair up: the server sees no
 * daemon, and its sign-ins carry on without a loopback listener.
 */
export type AgentOp =
  | { op: 'listen'; id: string; url: string }
  | { op: 'cancel'; id: string }

export type AgentReport =
  | { op: 'listening'; id: string }
  | { op: 'callback'; id: string; code: string; state: string }
  | { op: 'listen-failed'; id: string; error: string }
  | { op: 'denied'; id: string; error: string }
