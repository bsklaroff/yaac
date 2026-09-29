import { expect } from 'vitest'
import { buildApp } from '@yaac/server/main/server'
import type { DriverKind } from '@yaac/shared/types'

/**
 * Every route the server registers, and what each driver answers for it.
 *
 * ONE table, two columns — which is the point. A driver is chosen once at
 * startup and the layers above are meant to be substrate-blind, so the
 * interesting question about any route is not "does it work" but "does it
 * answer the same thing on both substrates, and if not, why not". Written as
 * two separate test files that would drift, that question is unaskable; here
 * a route's two answers sit on one line and a difference has to be typed out
 * deliberately.
 *
 * `assertMatrixCoversEveryRoute` closes it: it reads the routes Hono actually
 * registered and fails on any this table does not name. A new route therefore
 * cannot land without stating its answer under BOTH drivers — which is the
 * durable version of "remember to update the other file".
 *
 * What this asserts is deliberately narrow: the STATUS CLASS a caller sees,
 * against a server with no projects and no worktrees. It is a reachability
 * and driver-parity check, not a substitute for the behavioral suites
 * (`write-routes.test.ts` and the e2e tiers) — those drive real state.
 */

/** What a route answers. A number is exact; an array is "one of these". */
export type Expected = number | number[]

export interface RouteCase {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Exactly as Hono registered it, params and all. */
  path: string
  /** Concrete path to request — params filled with values that resolve to
   *  nothing, since the matrix runs against an empty server. */
  request?: string
  body?: unknown
  /** Why the two drivers differ, required whenever they do — a difference
   *  with no reason is the thing this table exists to catch. */
  why?: string
  k8s: Expected
  containerless: Expected
}

/** 404: no such project/worktree/build on an empty server — the route was
 *  reached and resolved its subject, which is what this table checks. */
const MISSING = 404
/** 501 NOT_SUPPORTED: this server's substrate has no such feature. */
const UNSUPPORTED = 501
/** Both, when reaching the feature guard vs the id resolve is ordering
 *  detail the table should not pin. */
const OK_OR_MISSING = [200, 404]

/**
 * The table. Grouped as the routes are, and every line states both columns.
 *
 * Most routes are IDENTICAL under both drivers, and that is the useful
 * signal: what a worktree runs on changes almost nothing a client can see.
 * The differences are exactly the features a host has no answer for.
 */
export const ROUTE_MATRIX: RouteCase[] = [
  // ── health and identity ───────────────────────────────────────────────
  { method: 'GET', path: '/api/health', k8s: 200, containerless: 200 },
  { method: 'GET', path: '/api/whoami', k8s: 200, containerless: 200 },

  // ── projects ──────────────────────────────────────────────────────────
  { method: 'GET', path: '/api/project/list', k8s: 200, containerless: 200 },
  { method: 'POST', path: '/api/project/add', body: { url: 'not a url' }, k8s: 400, containerless: 400 },
  { method: 'POST', path: '/api/project/register', body: {}, k8s: 400, containerless: 400 },
  { method: 'GET', path: '/api/project/:slug', request: '/api/project/nope', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/project/:slug/exists', request: '/api/project/nope/exists', k8s: MISSING, containerless: MISSING },
  { method: 'DELETE', path: '/api/project/:slug', request: '/api/project/nope', k8s: MISSING, containerless: MISSING },
  { method: 'PUT', path: '/api/project/:slug/git-credential', request: '/api/project/nope/git-credential', body: { credentialId: '00000000-0000-4000-8000-000000000000' }, k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/project/:slug/config', request: '/api/project/nope/config', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/project/:slug/config/raw', request: '/api/project/nope/config/raw', k8s: MISSING, containerless: MISSING },
  { method: 'PUT', path: '/api/project/:slug/config', request: '/api/project/nope/config', body: { config: {} }, k8s: MISSING, containerless: MISSING },
  { method: 'DELETE', path: '/api/project/:slug/config', request: '/api/project/nope/config', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/project/:slug/env', request: '/api/project/nope/env', k8s: MISSING, containerless: MISSING },
  { method: 'PUT', path: '/api/project/:slug/env', request: '/api/project/nope/env', body: { name: 'A', value: '1' }, k8s: MISSING, containerless: MISSING },
  { method: 'DELETE', path: '/api/project/:slug/env/:id', request: '/api/project/nope/env/abc', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/project/:slug/branches', request: '/api/project/nope/branches', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/project/:slug/skills', request: '/api/project/nope/skills', k8s: OK_OR_MISSING, containerless: OK_OR_MISSING },
  { method: 'GET', path: '/api/project/:slug/skills/body', request: '/api/project/nope/skills/body?path=x', k8s: [200, 400, 404], containerless: [200, 400, 404] },

  // ── images: the project's build inputs ────────────────────────────────
  // A containerless server builds no image, so a Dockerfile is an editable
  // layer over something that is never built and a build file is context for
  // a COPY that never runs. Refused rather than served empty: the webapp
  // hides these outright, so a client reaching them is asking for a feature
  // this install does not have.
  { method: 'GET', path: '/api/project/:slug/dockerfile', request: '/api/project/nope/dockerfile', why: 'builds no images', k8s: MISSING, containerless: UNSUPPORTED },
  { method: 'PUT', path: '/api/project/:slug/dockerfile', request: '/api/project/nope/dockerfile', body: { content: '' }, why: 'builds no images', k8s: MISSING, containerless: UNSUPPORTED },
  { method: 'GET', path: '/api/project/:slug/build-files', request: '/api/project/nope/build-files', why: 'builds no images', k8s: OK_OR_MISSING, containerless: UNSUPPORTED },
  { method: 'GET', path: '/api/project/:slug/build-files/file', request: '/api/project/nope/build-files/file?path=a', why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'PUT', path: '/api/project/:slug/build-files/file', request: '/api/project/nope/build-files/file', body: { path: 'a', content: '' }, why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'POST', path: '/api/project/:slug/build-files/rename', request: '/api/project/nope/build-files/rename', body: { from: 'a', to: 'b' }, why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'DELETE', path: '/api/project/:slug/build-files/file', request: '/api/project/nope/build-files/file?path=a', why: 'builds no images', k8s: [200, 204, 400, 404], containerless: UNSUPPORTED },
  // The git identity worktrees commit under. Not image-gated: every
  // substrate makes commits, and this is the setting that replaced reading
  // one off whichever host the server happened to be installed from.
  { method: 'GET', path: '/api/config/git-identity', k8s: 200, containerless: 200 },
  { method: 'PUT', path: '/api/config/git-identity', body: { name: 'A', email: 'a@b.co' }, k8s: 200, containerless: 200 },
  { method: 'GET', path: '/api/config/user-dockerfile', why: 'builds no images', k8s: 200, containerless: UNSUPPORTED },
  { method: 'PUT', path: '/api/config/user-dockerfile', body: { content: '' }, why: 'builds no images', k8s: 200, containerless: UNSUPPORTED },
  { method: 'GET', path: '/api/config/user-build-files', why: 'builds no images', k8s: 200, containerless: UNSUPPORTED },
  { method: 'GET', path: '/api/config/user-build-files/file', request: '/api/config/user-build-files/file?path=a', why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'PUT', path: '/api/config/user-build-files/file', body: { path: 'a', content: '' }, why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'POST', path: '/api/config/user-build-files/rename', body: { from: 'a', to: 'b' }, why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'DELETE', path: '/api/config/user-build-files/file', request: '/api/config/user-build-files/file?path=a', why: 'builds no images', k8s: [200, 204, 400, 404], containerless: UNSUPPORTED },

  // ── images: the build feed ────────────────────────────────────────────
  // The DRIVER still answers `[]` here — the snapshot composes the feed
  // unconditionally and must keep rendering. The ROUTE refuses, because `[]`
  // would tell a client "no builds are running" rather than "this server
  // never builds".
  { method: 'GET', path: '/api/image/builds', why: 'builds no images', k8s: 200, containerless: UNSUPPORTED },
  { method: 'GET', path: '/api/image/builds/:id/log', request: '/api/image/builds/x/log', why: 'builds no images', k8s: MISSING, containerless: UNSUPPORTED },
  { method: 'DELETE', path: '/api/image/builds/:id', request: '/api/image/builds/x', why: 'builds no images', k8s: 204, containerless: UNSUPPORTED },
  { method: 'POST', path: '/api/image/builds/:id/retry', request: '/api/image/builds/x/retry', why: 'builds no images', k8s: MISSING, containerless: UNSUPPORTED },

  // ── worktrees: the driver-neutral half ────────────────────────────────
  { method: 'GET', path: '/api/worktree/list', k8s: [200, 503], containerless: 200 },
  { method: 'GET', path: '/api/worktree/list-stopped', k8s: 200, containerless: 200 },
  { method: 'POST', path: '/api/worktree/create', body: { project: '' }, k8s: 400, containerless: 400 },
  // Resolves the worktree before it streams, so an unknown one is a plain
  // 404; past that, progress and any failure travel in the NDJSON stream.
  { method: 'POST', path: '/api/worktree/restart', body: { worktreeId: 'nope' }, k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/worktree/stop', body: { worktreeId: 'nope' }, k8s: [404, 503], containerless: MISSING },
  { method: 'POST', path: '/api/worktree/mark-death-seen', body: { projectSlug: 'nope', worktreeId: 'nope' }, k8s: [200, 204, 404], containerless: [200, 204, 404] },
  { method: 'POST', path: '/api/worktree/mark-all-deaths-seen', body: { projectSlug: 'nope' }, k8s: [200, 204], containerless: [200, 204] },
  // The in-worktree command channel. Only the runtime whose workspaces can
  // dial the server has it: a pod speaks to the egress proxy instead, and
  // holds no token to present here. 401 rather than a refusal on
  // containerless because the matrix asks with no worktree bearer, which is
  // exactly what an unknown caller looks like.
  { method: 'POST', path: '/api/worktree/mama', body: { command: 'list' },
    why: 'a pod reaches yaac-mama through the egress proxy, not the server',
    k8s: UNSUPPORTED, containerless: 401 },
  // Queued worktrees are rows and a create request: substrate-neutral.
  { method: 'POST', path: '/api/worktree/queue/create', body: { project: 'nope', parent: 'nope', prompt: 'p' }, k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/worktree/queue/update', body: { id: 'nope', prompt: 'p' }, k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/worktree/queue/discard', body: { id: 'nope' }, k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/worktree/queue/run', body: { id: 'nope' }, k8s: MISSING, containerless: MISSING },
  // Drafts are rows alone: substrate-neutral.
  { method: 'POST', path: '/api/worktree/draft/save', body: { project: 'nope', prompt: 'p', tool: 'claude', mode: 'tui', permissionMode: 'manual' }, k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/worktree/draft/discard', body: { id: 'nope' }, k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/worktree/group/list', k8s: 200, containerless: 200 },
  { method: 'POST', path: '/api/worktree/group/create', body: { name: 'g' }, k8s: [200, 400], containerless: [200, 400] },
  { method: 'POST', path: '/api/worktree/group/move', body: { worktreeId: 'nope', group: null }, k8s: [200, 400, 404], containerless: [200, 400, 404] },
  { method: 'POST', path: '/api/worktree/group/rename', body: { id: 'nope', name: 'g' }, k8s: [200, 204, 400, 404], containerless: [200, 204, 400, 404] },
  { method: 'POST', path: '/api/worktree/group/set-pinned', body: { id: 'nope', pinned: true }, k8s: [200, 204, 400, 404], containerless: [200, 204, 400, 404] },
  { method: 'POST', path: '/api/worktree/group/delete', body: { id: 'nope' }, k8s: [200, 204, 400, 404], containerless: [200, 204, 400, 404] },
  { method: 'POST', path: '/api/worktree/set-group', body: { worktreeId: 'nope', groupId: null }, k8s: [200, 204, 400, 404], containerless: [200, 204, 400, 404] },
  { method: 'POST', path: '/api/worktree/provisioning/:id/dismiss', request: '/api/worktree/provisioning/x/dismiss', k8s: [200, 204, 404], containerless: [200, 204, 404] },
  { method: 'POST', path: '/api/worktree/:id/title', request: '/api/worktree/nope/title', body: { title: 't' }, k8s: [200, 204, 404], containerless: [200, 204, 404] },
  { method: 'GET', path: '/api/worktree/:id', request: '/api/worktree/nope', k8s: [404, 503], containerless: MISSING },
  { method: 'GET', path: '/api/worktree/:id/agent-sessions', request: '/api/worktree/nope/agent-sessions', k8s: MISSING, containerless: MISSING },
  // Reads recorded state and files on the host, so it answers the same under
  // both substrates — the 501 it can raise is about the *tool* whose
  // conversation is asked for (opencode keeps its history in the container),
  // never about which driver is installed.
  { method: 'GET', path: '/api/worktree/:id/agent-sessions/:sessionId/transcript', request: '/api/worktree/nope/agent-sessions/s1/transcript', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/worktree/:id/changes', request: '/api/worktree/nope/changes', k8s: [404, 503], containerless: MISSING },
  // Read off the server's own refs, resolved from the record like the file
  // editor below — no workspace needed, so both substrates answer alike.
  { method: 'GET', path: '/api/worktree/:id/git-status', request: '/api/worktree/nope/git-status', k8s: MISSING, containerless: MISSING },
  // The file editor reads the checkout on the server's own disk, resolved from
  // the record — so it needs no workspace and answers alike on both substrates.
  { method: 'GET', path: '/api/worktree/:id/files', request: '/api/worktree/nope/files', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/worktree/:id/dir', request: '/api/worktree/nope/dir?path=a', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/worktree/:id/file', request: '/api/worktree/nope/file?path=a', k8s: MISSING, containerless: MISSING },
  { method: 'PUT', path: '/api/worktree/:id/file', request: '/api/worktree/nope/file', body: { path: 'a', content: '', baseVersion: null }, k8s: MISSING, containerless: MISSING },
  { method: 'DELETE', path: '/api/worktree/:id/file', request: '/api/worktree/nope/file?path=a', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/worktree/:id/folder', request: '/api/worktree/nope/folder', body: { path: 'a' }, k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/worktree/:id/rename', request: '/api/worktree/nope/rename', body: { from: 'a', to: 'b' }, k8s: MISSING, containerless: MISSING },
  // Recorded state too, and resolved from the record for the same reason: the
  // founding ask outlives the workspace, so neither substrate needs one to
  // answer — which is why no 503 sits beside the 404 here.
  { method: 'GET', path: '/api/worktree/:id/prompt', request: '/api/worktree/nope/prompt', k8s: [200, 404], containerless: [200, 404] },
  // An image pasted into a terminal pane, for its agent to read: only a
  // running workspace has one to hand it to.
  { method: 'POST', path: '/api/worktree/:id/attachments', request: '/api/worktree/nope/attachments', k8s: [404, 503], containerless: MISSING },
  { method: 'GET', path: '/api/worktree/:id/terminals', request: '/api/worktree/nope/terminals', k8s: [404, 409, 503], containerless: MISSING },
  { method: 'POST', path: '/api/worktree/:id/terminals', request: '/api/worktree/nope/terminals', k8s: [404, 409, 503], containerless: MISSING },
  { method: 'POST', path: '/api/worktree/:id/terminals/close', request: '/api/worktree/nope/terminals/close', body: { target: 'window:@1' }, k8s: [404, 409, 503], containerless: MISSING },

  // ── worktrees: egress and the port relay ──────────────────────────────
  // Guarded before the id resolve: what this server can do is not a property
  // of the worktree being asked about, so the answer must not depend on one
  // existing.
  { method: 'GET', path: '/api/worktree/:id/blocked-hosts', request: '/api/worktree/nope/blocked-hosts', why: 'mediates no egress', k8s: [404, 503], containerless: UNSUPPORTED },
  { method: 'POST', path: '/api/worktree/:id/allow-host', request: '/api/worktree/nope/allow-host', body: { host: 'example.com' }, why: 'mediates no egress', k8s: [404, 503], containerless: UNSUPPORTED },
  { method: 'POST', path: '/api/worktree/:id/forward-port', request: '/api/worktree/nope/forward-port', body: { containerPort: 3000 }, why: 'relays no ports', k8s: [404, 503], containerless: UNSUPPORTED },
  { method: 'POST', path: '/api/worktree/:id/dismiss-port', request: '/api/worktree/nope/dismiss-port', body: { containerPort: 3000 }, why: 'relays no ports', k8s: [404, 503], containerless: UNSUPPORTED },

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
 * Fail on any route the server registers that this table does not name.
 *
 * The enforcement the table needs to stay true: without it a new route
 * simply goes untested under both drivers, silently, which is the failure
 * mode a hand-maintained list always eventually has.
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
