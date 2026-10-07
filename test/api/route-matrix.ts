import { expect } from 'vitest'
import { buildApp } from '@yaac/server/main/server'
import type { DriverKind } from '@yaac/shared/types'

/**
 * Every route the server registers, and what each driver answers for it.
 *
 * One table with a column per driver, so each route states both answers on
 * one line and any difference must be written out with a `why`.
 * `assertMatrixCoversEveryRoute` fails on any registered route the table
 * does not name.
 *
 * It checks only the status a caller gets from a server with no projects
 * or workspaces. Behavior is covered by `write-routes.test.ts` and the e2e
 * tiers.
 */

/** What a route answers. A number is exact; an array is "one of these". */
export type Expected = number | number[]

export interface RouteCase {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Exactly as Hono registered it, params and all. */
  path: string
  /** Concrete path to request, with params that resolve to nothing. */
  request?: string
  body?: unknown
  /** Why the two drivers differ; required whenever they do. */
  why?: string
  k8s: Expected
  containerless: Expected
}

/** 404: the route was reached and found no such project/workspace/build. */
const MISSING = 404
/** 501 NOT_SUPPORTED: this server's substrate has no such feature. */
const UNSUPPORTED = 501
/** Either, where the table should not pin which check runs first. */
const OK_OR_MISSING = [200, 404]

/**
 * The table, grouped as the routes are. Most routes answer identically
 * under both drivers; the differences are features a host install lacks.
 */
export const ROUTE_MATRIX: RouteCase[] = [
  // ── health and identity ───────────────────────────────────────────────
  { method: 'GET', path: '/api/health', k8s: 200, containerless: 200 },
  { method: 'GET', path: '/api/whoami', k8s: 200, containerless: 200 },

  // ── projects ──────────────────────────────────────────────────────────
  { method: 'GET', path: '/api/project/list', k8s: 200, containerless: 200 },
  { method: 'POST', path: '/api/project/add', body: { url: 'not a url' }, k8s: 400, containerless: 400 },
  { method: 'POST', path: '/api/project/register', body: {}, k8s: 400, containerless: 400 },
  { method: 'GET', path: '/api/project/:projectId', request: '/api/project/nope', k8s: MISSING, containerless: MISSING },
  { method: 'DELETE', path: '/api/project/:projectId', request: '/api/project/nope', k8s: MISSING, containerless: MISSING },
  { method: 'PUT', path: '/api/project/:projectId/git-credential', request: '/api/project/nope/git-credential', body: { credentialId: '00000000-0000-4000-8000-000000000000' }, k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/project/:projectId/config', request: '/api/project/nope/config', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/project/:projectId/config/raw', request: '/api/project/nope/config/raw', k8s: MISSING, containerless: MISSING },
  { method: 'PUT', path: '/api/project/:projectId/config', request: '/api/project/nope/config', body: { config: {} }, k8s: MISSING, containerless: MISSING },
  { method: 'DELETE', path: '/api/project/:projectId/config', request: '/api/project/nope/config', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/project/:projectId/env', request: '/api/project/nope/env', k8s: MISSING, containerless: MISSING },
  { method: 'PUT', path: '/api/project/:projectId/env', request: '/api/project/nope/env', body: { name: 'A', value: '1' }, k8s: MISSING, containerless: MISSING },
  { method: 'DELETE', path: '/api/project/:projectId/env/:id', request: '/api/project/nope/env/abc', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/project/:projectId/branches', request: '/api/project/nope/branches', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/project/:projectId/skills', request: '/api/project/nope/skills', k8s: OK_OR_MISSING, containerless: OK_OR_MISSING },
  { method: 'GET', path: '/api/project/:projectId/skills/body', request: '/api/project/nope/skills/body?path=x', k8s: [200, 400, 404], containerless: [200, 400, 404] },

  // ── images: the project's build inputs ────────────────────────────────
  // A containerless server builds no images, so these refuse rather than
  // answer empty.
  { method: 'GET', path: '/api/project/:projectId/dockerfile', request: '/api/project/nope/dockerfile', why: 'builds no images', k8s: MISSING, containerless: UNSUPPORTED },
  { method: 'PUT', path: '/api/project/:projectId/dockerfile', request: '/api/project/nope/dockerfile', body: { content: '' }, why: 'builds no images', k8s: MISSING, containerless: UNSUPPORTED },
  { method: 'GET', path: '/api/project/:projectId/build-files', request: '/api/project/nope/build-files', why: 'builds no images', k8s: OK_OR_MISSING, containerless: UNSUPPORTED },
  { method: 'GET', path: '/api/project/:projectId/build-files/file', request: '/api/project/nope/build-files/file?path=a', why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'PUT', path: '/api/project/:projectId/build-files/file', request: '/api/project/nope/build-files/file', body: { path: 'a', content: '' }, why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'POST', path: '/api/project/:projectId/build-files/rename', request: '/api/project/nope/build-files/rename', body: { from: 'a', to: 'b' }, why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'DELETE', path: '/api/project/:projectId/build-files/file', request: '/api/project/nope/build-files/file?path=a', why: 'builds no images', k8s: [200, 204, 400, 404], containerless: UNSUPPORTED },
  // The git identity workspaces commit under and the zone they run in;
  // every substrate needs both.
  { method: 'GET', path: '/api/config/git-identity', k8s: 200, containerless: 200 },
  { method: 'PUT', path: '/api/config/git-identity', body: { name: 'A', email: 'a@b.co' }, k8s: 200, containerless: 200 },
  { method: 'GET', path: '/api/config/time-zone', k8s: 200, containerless: 200 },
  { method: 'PUT', path: '/api/config/time-zone', body: { timeZone: 'America/New_York' }, k8s: 200, containerless: 200 },
  { method: 'GET', path: '/api/config/user-dockerfile', why: 'builds no images', k8s: 200, containerless: UNSUPPORTED },
  { method: 'PUT', path: '/api/config/user-dockerfile', body: { content: '' }, why: 'builds no images', k8s: 200, containerless: UNSUPPORTED },
  { method: 'GET', path: '/api/config/user-build-files', why: 'builds no images', k8s: 200, containerless: UNSUPPORTED },
  { method: 'GET', path: '/api/config/user-build-files/file', request: '/api/config/user-build-files/file?path=a', why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'PUT', path: '/api/config/user-build-files/file', body: { path: 'a', content: '' }, why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'POST', path: '/api/config/user-build-files/rename', body: { from: 'a', to: 'b' }, why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'DELETE', path: '/api/config/user-build-files/file', request: '/api/config/user-build-files/file?path=a', why: 'builds no images', k8s: [200, 204, 400, 404], containerless: UNSUPPORTED },

  // ── images: the build feed ────────────────────────────────────────────
  // The driver answers `[]` so the snapshot keeps rendering, but the route
  // refuses: `[]` would mean "no builds running", not "never builds".
  { method: 'GET', path: '/api/image/builds', why: 'builds no images', k8s: 200, containerless: UNSUPPORTED },
  { method: 'GET', path: '/api/image/builds/:id/log', request: '/api/image/builds/x/log', why: 'builds no images', k8s: MISSING, containerless: UNSUPPORTED },
  { method: 'DELETE', path: '/api/image/builds/:id', request: '/api/image/builds/x', why: 'builds no images', k8s: 204, containerless: UNSUPPORTED },
  { method: 'POST', path: '/api/image/builds/:id/retry', request: '/api/image/builds/x/retry', why: 'builds no images', k8s: MISSING, containerless: UNSUPPORTED },

  // ── workspaces: the driver-neutral half ────────────────────────────────
  { method: 'GET', path: '/api/workspace/list', k8s: [200, 503], containerless: 200 },
  { method: 'GET', path: '/api/workspace/list-stopped', k8s: 200, containerless: 200 },
  { method: 'POST', path: '/api/workspace/create', body: { project: '' }, k8s: 400, containerless: 400 },
  // An unknown workspace is a plain 404; later failures travel in the
  // NDJSON stream.
  { method: 'POST', path: '/api/workspace/restart', body: { workspaceId: 'nope' }, k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/stop', body: { workspaceId: 'nope' }, k8s: [404, 503], containerless: MISSING },
  { method: 'POST', path: '/api/workspace/mark-death-seen', body: { projectId: 'nope', workspaceId: 'nope' }, k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/mark-all-deaths-seen', body: { projectId: 'nope' }, k8s: MISSING, containerless: MISSING },
  // The in-workspace command channel. Containerless answers 401 because the
  // matrix sends no workspace bearer token.
  { method: 'POST', path: '/api/workspace/mama', body: { command: 'list' },
    why: 'the egress proxy relays a pod\'s yaac-mama calls to a listener of their own',
    k8s: UNSUPPORTED, containerless: 401 },
  { method: 'POST', path: '/api/workspace/queue/create', body: { project: 'nope', parent: 'nope', prompt: 'p' }, k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/queue/update', body: { id: 'nope', prompt: 'p' }, k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/queue/discard', body: { id: 'nope' }, k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/queue/run', body: { id: 'nope' }, k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/draft/save', body: { project: 'nope', prompt: 'p', tool: 'claude', mode: 'tui', permissionMode: 'manual' }, k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/draft/discard', body: { id: 'nope' }, k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/workspace/group/list', k8s: 200, containerless: 200 },
  { method: 'POST', path: '/api/workspace/group/create', body: { name: 'g' }, k8s: [200, 400], containerless: [200, 400] },
  { method: 'POST', path: '/api/workspace/group/move', body: { workspaceId: 'nope', group: null }, k8s: [200, 400, 404], containerless: [200, 400, 404] },
  { method: 'POST', path: '/api/workspace/group/rename', body: { id: 'nope', name: 'g' }, k8s: [200, 204, 400, 404], containerless: [200, 204, 400, 404] },
  { method: 'POST', path: '/api/workspace/group/set-pinned', body: { id: 'nope', pinned: true }, k8s: [200, 204, 400, 404], containerless: [200, 204, 400, 404] },
  { method: 'POST', path: '/api/workspace/group/delete', body: { id: 'nope' }, k8s: [200, 204, 400, 404], containerless: [200, 204, 400, 404] },
  { method: 'POST', path: '/api/workspace/set-group', body: { workspaceId: 'nope', groupId: null }, k8s: [200, 204, 400, 404], containerless: [200, 204, 400, 404] },
  { method: 'POST', path: '/api/workspace/provisioning/:id/dismiss', request: '/api/workspace/provisioning/x/dismiss', k8s: [200, 204, 404], containerless: [200, 204, 404] },
  { method: 'POST', path: '/api/workspace/:id/title', request: '/api/workspace/nope/title', body: { title: 't' }, k8s: [200, 204, 404], containerless: [200, 204, 404] },
  { method: 'GET', path: '/api/workspace/:id', request: '/api/workspace/nope', k8s: [404, 503], containerless: MISSING },
  { method: 'GET', path: '/api/workspace/:id/agent-sessions', request: '/api/workspace/nope/agent-sessions', k8s: MISSING, containerless: MISSING },
  // Reads recorded state and host files, so both drivers agree. Its 501 is
  // for a tool (opencode) whose history lives in the container.
  { method: 'GET', path: '/api/workspace/:id/agent-sessions/:sessionId/transcript', request: '/api/workspace/nope/agent-sessions/s1/transcript', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/workspace/:id/changes', request: '/api/workspace/nope/changes', k8s: [404, 503], containerless: MISSING },
  // Run git inside the running workspace: 409 when stopped, 404 when
  // unknown.
  { method: 'GET', path: '/api/workspace/:id/git-status', request: '/api/workspace/nope/git-status', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/workspace/:id/files', request: '/api/workspace/nope/files', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/workspace/:id/file-at', request: `/api/workspace/nope/file-at?path=a&rev=${'0'.repeat(40)}`, k8s: MISSING, containerless: MISSING },
  // The rest of the file editor reads the checkout on the server's disk, so
  // it needs no running workspace.
  { method: 'GET', path: '/api/workspace/:id/dir', request: '/api/workspace/nope/dir?path=a', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/workspace/:id/file', request: '/api/workspace/nope/file?path=a', k8s: MISSING, containerless: MISSING },
  { method: 'PUT', path: '/api/workspace/:id/file', request: '/api/workspace/nope/file', body: { path: 'a', content: '', baseVersion: null }, k8s: MISSING, containerless: MISSING },
  { method: 'DELETE', path: '/api/workspace/:id/file', request: '/api/workspace/nope/file?path=a', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/:id/folder', request: '/api/workspace/nope/folder', body: { path: 'a' }, k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/:id/rename', request: '/api/workspace/nope/rename', body: { from: 'a', to: 'b' }, k8s: MISSING, containerless: MISSING },
  // Recorded state, so no running workspace (and no 503) is involved.
  { method: 'GET', path: '/api/workspace/:id/prompt', request: '/api/workspace/nope/prompt', k8s: [200, 404], containerless: [200, 404] },
  // An image pasted into a terminal pane; needs a running workspace.
  { method: 'POST', path: '/api/workspace/:id/attachments', request: '/api/workspace/nope/attachments', k8s: [404, 503], containerless: MISSING },
  { method: 'POST', path: '/api/workspace/:id/terminals', request: '/api/workspace/nope/terminals', k8s: [404, 409, 503], containerless: MISSING },
  { method: 'POST', path: '/api/workspace/:id/terminals/close', request: '/api/workspace/nope/terminals/close', body: { target: 'window:@1' }, k8s: [404, 409, 503], containerless: MISSING },

  // ── workspaces: egress and the port relay ──────────────────────────────
  // The feature guard runs before the id lookup, so the refusal doesn't
  // depend on the workspace existing.
  { method: 'GET', path: '/api/workspace/:id/blocked-hosts', request: '/api/workspace/nope/blocked-hosts', why: 'mediates no egress', k8s: [404, 503], containerless: UNSUPPORTED },
  { method: 'POST', path: '/api/workspace/:id/allow-host', request: '/api/workspace/nope/allow-host', body: { host: 'example.com' }, why: 'mediates no egress', k8s: [404, 503], containerless: UNSUPPORTED },
  { method: 'POST', path: '/api/workspace/:id/forward-port', request: '/api/workspace/nope/forward-port', body: { containerPort: 3000 }, why: 'relays no ports', k8s: [404, 503], containerless: UNSUPPORTED },
  { method: 'POST', path: '/api/workspace/:id/dismiss-port', request: '/api/workspace/nope/dismiss-port', body: { containerPort: 3000 }, why: 'relays no ports', k8s: [404, 503], containerless: UNSUPPORTED },

  // ── shortcuts ─────────────────────────────────────────────────────────
  { method: 'GET', path: '/api/shortcuts/get', k8s: 200, containerless: 200 },
  { method: 'POST', path: '/api/shortcuts/set', body: { commandId: 'x', chord: null }, k8s: [200, 204, 400], containerless: [200, 204, 400] },
  { method: 'POST', path: '/api/shortcuts/reset', body: {}, k8s: [200, 204], containerless: [200, 204] },

  // ── auth: entirely driver-neutral, credentials are the server's ───────
  { method: 'GET', path: '/api/auth/list', k8s: 200, containerless: 200 },
  { method: 'GET', path: '/api/auth/agent', k8s: [200, 503], containerless: [200, 503] },
  { method: 'POST', path: '/api/auth/clear', body: {}, k8s: [200, 204, 400], containerless: [200, 204, 400] },
  { method: 'POST', path: '/api/auth/fake', body: { kind: 'not-a-kind' }, k8s: 400, containerless: 400 },
  { method: 'PUT', path: '/api/auth/:tool', request: '/api/auth/claude', body: {}, k8s: 400, containerless: 400 },
  { method: 'POST', path: '/api/auth/claude/usage/refresh', body: {}, k8s: [200, 204, 400, 401, 404], containerless: [200, 204, 400, 401, 404] },
  { method: 'POST', path: '/api/auth/git/credentials', body: {}, k8s: 400, containerless: 400 },
  { method: 'POST', path: '/api/auth/git/ssh-keys', body: {}, k8s: 400, containerless: 400 },
  { method: 'PATCH', path: '/api/auth/git/credentials/:id', request: '/api/auth/git/credentials/00000000-0000-4000-8000-000000000000', body: { name: 'x' }, k8s: 404, containerless: 404 },
  { method: 'POST', path: '/api/auth/git/credentials/:id/replace', request: '/api/auth/git/credentials/00000000-0000-4000-8000-000000000000/replace', body: { token: 'x' }, k8s: 404, containerless: 404 },
  { method: 'DELETE', path: '/api/auth/git/credentials/:id', request: '/api/auth/git/credentials/00000000-0000-4000-8000-000000000000', k8s: 404, containerless: 404 },
  { method: 'POST', path: '/api/auth/:tool/login/start', request: '/api/auth/claude/login/start', body: {}, k8s: [200, 400, 409, 503], containerless: [200, 400, 409, 503] },
  { method: 'GET', path: '/api/auth/login/:id', request: '/api/auth/login/nope', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/auth/login/:id/input', request: '/api/auth/login/nope/input', body: { input: 'x' }, k8s: [400, 404], containerless: [400, 404] },
  { method: 'POST', path: '/api/auth/login/:id/cancel', request: '/api/auth/login/nope/cancel', k8s: [200, 204, 404], containerless: [200, 204, 404] },
  { method: 'POST', path: '/api/auth/:tool/install/start', request: '/api/auth/claude/install/start', body: {}, k8s: [200, 400, 409, 503], containerless: [200, 400, 409, 503] },
  { method: 'GET', path: '/api/auth/install/:id', request: '/api/auth/install/nope', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/auth/install/:id/cancel', request: '/api/auth/install/nope/cancel', k8s: [200, 204, 404], containerless: [200, 204, 404] },
]

/**
 * Fail on any route the server registers that this table does not name,
 * or any row naming a route that no longer exists.
 */
export function assertMatrixCoversEveryRoute(): void {
  const app = buildApp({ buildId: 'matrix' })
  const registered = new Set(
    (app.routes as Array<{ method: string; path: string }>)
      // `ALL` entries are middleware (auth, CORS, the feature guard on the
      // build-files sub-app), not routes a client can address.
      .filter((r) => r.method !== 'ALL')
      .map((r) => `${r.method} ${r.path}`),
  )
  const covered = new Set(ROUTE_MATRIX.map((r) => `${r.method} ${r.path}`))
  const missing = [...registered].filter((r) => !covered.has(r)).sort()
  const stale = [...covered].filter((r) => !registered.has(r)).sort()
  expect(
    { missing, stale },
    'Every route states its answer under BOTH drivers — add the new one to '
    + 'ROUTE_MATRIX (test/api/route-matrix.ts), or drop the row for a route '
    + 'that no longer exists.',
  ).toEqual({ missing: [], stale: [] })
}

/** The status(es) a case expects under `kind`. */
export function expectedFor(route: RouteCase, kind: DriverKind): number[] {
  const want = kind === 'k8s' ? route.k8s : route.containerless
  return Array.isArray(want) ? want : [want]
}

/** A one-line label for a case, used as the test name. */
export function label(route: RouteCase): string {
  return `${route.method} ${route.path}`
}
