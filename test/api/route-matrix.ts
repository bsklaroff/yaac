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
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
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
  // ── health and session ────────────────────────────────────────────────
  { method: 'GET', path: '/health', k8s: 200, containerless: 200 },
  { method: 'GET', path: '/auth/web-session', k8s: 204, containerless: 204 },
  { method: 'POST', path: '/auth/web-session', body: {}, k8s: [200, 400, 401], containerless: [200, 400, 401] },

  // ── projects ──────────────────────────────────────────────────────────
  { method: 'GET', path: '/project/list', k8s: 200, containerless: 200 },
  { method: 'POST', path: '/project/add', body: { url: 'not a url' }, k8s: 400, containerless: 400 },
  { method: 'GET', path: '/project/:slug', request: '/project/nope', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/project/:slug/exists', request: '/project/nope/exists', k8s: MISSING, containerless: MISSING },
  { method: 'DELETE', path: '/project/:slug', request: '/project/nope', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/project/:slug/config', request: '/project/nope/config', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/project/:slug/config/raw', request: '/project/nope/config/raw', k8s: MISSING, containerless: MISSING },
  { method: 'PUT', path: '/project/:slug/config', request: '/project/nope/config', body: { config: {} }, k8s: MISSING, containerless: MISSING },
  { method: 'DELETE', path: '/project/:slug/config', request: '/project/nope/config', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/project/:slug/env', request: '/project/nope/env', k8s: MISSING, containerless: MISSING },
  { method: 'PUT', path: '/project/:slug/env', request: '/project/nope/env', body: { name: 'A', value: '1' }, k8s: MISSING, containerless: MISSING },
  { method: 'DELETE', path: '/project/:slug/env/:id', request: '/project/nope/env/abc', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/project/:slug/branches', request: '/project/nope/branches', k8s: MISSING, containerless: MISSING },
  { method: 'PUT', path: '/project/:slug/reference-branch', request: '/project/nope/reference-branch', body: { branch: 'main' }, k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/project/:slug/skills', request: '/project/nope/skills', k8s: OK_OR_MISSING, containerless: OK_OR_MISSING },
  { method: 'GET', path: '/project/:slug/skills/body', request: '/project/nope/skills/body?path=x', k8s: [200, 400, 404], containerless: [200, 400, 404] },

  // ── images: the project's build inputs ────────────────────────────────
  // A containerless server builds no image, so a Dockerfile is an editable
  // layer over something that is never built and a build file is context for
  // a COPY that never runs. Refused rather than served empty: the webapp
  // hides these outright, so a client reaching them is asking for a feature
  // this install does not have.
  { method: 'GET', path: '/project/:slug/dockerfile', request: '/project/nope/dockerfile', why: 'builds no images', k8s: MISSING, containerless: UNSUPPORTED },
  { method: 'PUT', path: '/project/:slug/dockerfile', request: '/project/nope/dockerfile', body: { content: '' }, why: 'builds no images', k8s: MISSING, containerless: UNSUPPORTED },
  { method: 'GET', path: '/project/:slug/build-files', request: '/project/nope/build-files', why: 'builds no images', k8s: OK_OR_MISSING, containerless: UNSUPPORTED },
  { method: 'GET', path: '/project/:slug/build-files/file', request: '/project/nope/build-files/file?path=a', why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'PUT', path: '/project/:slug/build-files/file', request: '/project/nope/build-files/file', body: { path: 'a', content: '' }, why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'POST', path: '/project/:slug/build-files/rename', request: '/project/nope/build-files/rename', body: { from: 'a', to: 'b' }, why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'DELETE', path: '/project/:slug/build-files/file', request: '/project/nope/build-files/file?path=a', why: 'builds no images', k8s: [200, 204, 400, 404], containerless: UNSUPPORTED },
  // The git identity worktrees commit under. Not image-gated: every
  // substrate makes commits, and this is the setting that replaced reading
  // one off whichever host the server happened to be installed from.
  { method: 'GET', path: '/config/git-identity', k8s: 200, containerless: 200 },
  { method: 'PUT', path: '/config/git-identity', body: { name: 'A', email: 'a@b.co' }, k8s: 200, containerless: 200 },
  { method: 'GET', path: '/config/user-dockerfile', why: 'builds no images', k8s: 200, containerless: UNSUPPORTED },
  { method: 'PUT', path: '/config/user-dockerfile', body: { content: '' }, why: 'builds no images', k8s: 200, containerless: UNSUPPORTED },
  { method: 'GET', path: '/config/user-build-files', why: 'builds no images', k8s: 200, containerless: UNSUPPORTED },
  { method: 'GET', path: '/config/user-build-files/file', request: '/config/user-build-files/file?path=a', why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'PUT', path: '/config/user-build-files/file', body: { path: 'a', content: '' }, why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'POST', path: '/config/user-build-files/rename', body: { from: 'a', to: 'b' }, why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'DELETE', path: '/config/user-build-files/file', request: '/config/user-build-files/file?path=a', why: 'builds no images', k8s: [200, 204, 400, 404], containerless: UNSUPPORTED },

  // ── images: the build feed ────────────────────────────────────────────
  // The DRIVER still answers `[]` here — the snapshot composes the feed
  // unconditionally and must keep rendering. The ROUTE refuses, because `[]`
  // would tell a client "no builds are running" rather than "this server
  // never builds".
  { method: 'GET', path: '/image/builds', why: 'builds no images', k8s: 200, containerless: UNSUPPORTED },
  { method: 'GET', path: '/image/builds/:id/log', request: '/image/builds/x/log', why: 'builds no images', k8s: MISSING, containerless: UNSUPPORTED },
  { method: 'DELETE', path: '/image/builds/:id', request: '/image/builds/x', why: 'builds no images', k8s: 204, containerless: UNSUPPORTED },
  { method: 'POST', path: '/image/builds/:id/retry', request: '/image/builds/x/retry', why: 'builds no images', k8s: MISSING, containerless: UNSUPPORTED },

  // ── worktrees: the driver-neutral half ────────────────────────────────
  { method: 'GET', path: '/worktree/list', k8s: [200, 503], containerless: 200 },
  { method: 'GET', path: '/worktree/list-stopped', k8s: 200, containerless: 200 },
  { method: 'POST', path: '/worktree/create', body: { project: '' }, k8s: 400, containerless: 400 },
  // Streams its progress as NDJSON, so the status is 200 before the work
  // starts and a failure travels in the stream rather than in the code.
  { method: 'POST', path: '/worktree/restart', body: { worktreeId: 'nope' }, k8s: 200, containerless: 200 },
  { method: 'POST', path: '/worktree/stop', body: { worktreeId: 'nope' }, k8s: [404, 503], containerless: MISSING },
  { method: 'POST', path: '/worktree/mark-death-seen', body: { projectSlug: 'nope', worktreeId: 'nope' }, k8s: [200, 204, 404], containerless: [200, 204, 404] },
  { method: 'POST', path: '/worktree/mark-all-deaths-seen', body: { projectSlug: 'nope' }, k8s: [200, 204], containerless: [200, 204] },
  // The in-worktree command channel. Only the runtime whose workspaces can
  // dial the server has it: a pod speaks to the egress proxy instead, and
  // holds no token to present here. 401 rather than a refusal on
  // containerless because the matrix asks with no bearer, which is exactly
  // what an unknown caller looks like.
  { method: 'POST', path: '/worktree/mama', body: { command: 'list' },
    why: 'a pod reaches yaac-mama through the egress proxy, not the server',
    k8s: UNSUPPORTED, containerless: 401 },
  { method: 'GET', path: '/worktree/group/list', k8s: 200, containerless: 200 },
  { method: 'POST', path: '/worktree/group/create', body: { name: 'g' }, k8s: [200, 400], containerless: [200, 400] },
  { method: 'POST', path: '/worktree/group/move', body: { worktreeId: 'nope', group: null }, k8s: [200, 400, 404], containerless: [200, 400, 404] },
  { method: 'POST', path: '/worktree/group/rename', body: { id: 'nope', name: 'g' }, k8s: [200, 204, 400, 404], containerless: [200, 204, 400, 404] },
  { method: 'POST', path: '/worktree/group/set-pinned', body: { id: 'nope', pinned: true }, k8s: [200, 204, 400, 404], containerless: [200, 204, 400, 404] },
  { method: 'POST', path: '/worktree/group/delete', body: { id: 'nope' }, k8s: [200, 204, 400, 404], containerless: [200, 204, 400, 404] },
  { method: 'POST', path: '/worktree/set-group', body: { worktreeId: 'nope', groupId: null }, k8s: [200, 204, 400, 404], containerless: [200, 204, 400, 404] },
  { method: 'POST', path: '/worktree/provisioning/:id/dismiss', request: '/worktree/provisioning/x/dismiss', k8s: [200, 204, 404], containerless: [200, 204, 404] },
  { method: 'POST', path: '/worktree/:id/title', request: '/worktree/nope/title', body: { title: 't' }, k8s: [200, 204, 404], containerless: [200, 204, 404] },
  { method: 'GET', path: '/worktree/:id', request: '/worktree/nope', k8s: [404, 503], containerless: MISSING },
  { method: 'GET', path: '/worktree/:id/agent-sessions', request: '/worktree/nope/agent-sessions', k8s: MISSING, containerless: MISSING },
  // Reads recorded state and files on the host, so it answers the same under
  // both substrates — the 501 it can raise is about the *tool* whose
  // conversation is asked for (opencode keeps its history in the container),
  // never about which driver is installed.
  { method: 'GET', path: '/worktree/:id/agent-sessions/:sessionId/transcript', request: '/worktree/nope/agent-sessions/s1/transcript', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/worktree/:id/changes', request: '/worktree/nope/changes', k8s: [404, 503], containerless: MISSING },
  // Recorded state too, and resolved from the record for the same reason: the
  // founding ask outlives the workspace, so neither substrate needs one to
  // answer — which is why no 503 sits beside the 404 here.
  { method: 'GET', path: '/worktree/:id/prompt', request: '/worktree/nope/prompt', k8s: [200, 404], containerless: [200, 404] },
  { method: 'GET', path: '/worktree/:id/terminals', request: '/worktree/nope/terminals', k8s: [404, 409, 503], containerless: MISSING },
  { method: 'POST', path: '/worktree/:id/terminals', request: '/worktree/nope/terminals', k8s: [404, 409, 503], containerless: MISSING },
  { method: 'POST', path: '/worktree/:id/terminals/close', request: '/worktree/nope/terminals/close', body: { target: 'window:@1' }, k8s: [404, 409, 503], containerless: MISSING },

  // ── worktrees: egress and the port relay ──────────────────────────────
  // Guarded before the id resolve: what this server can do is not a property
  // of the worktree being asked about, so the answer must not depend on one
  // existing.
  { method: 'GET', path: '/worktree/:id/blocked-hosts', request: '/worktree/nope/blocked-hosts', why: 'mediates no egress', k8s: [404, 503], containerless: UNSUPPORTED },
  { method: 'POST', path: '/worktree/:id/allow-host', request: '/worktree/nope/allow-host', body: { host: 'example.com' }, why: 'mediates no egress', k8s: [404, 503], containerless: UNSUPPORTED },
  { method: 'POST', path: '/worktree/:id/forward-port', request: '/worktree/nope/forward-port', body: { containerPort: 3000 }, why: 'relays no ports', k8s: [404, 503], containerless: UNSUPPORTED },
  { method: 'POST', path: '/worktree/:id/dismiss-port', request: '/worktree/nope/dismiss-port', body: { containerPort: 3000 }, why: 'relays no ports', k8s: [404, 503], containerless: UNSUPPORTED },

  // ── tools, shortcuts, tokens ──────────────────────────────────────────
  { method: 'GET', path: '/tool/get', k8s: 200, containerless: 200 },
  { method: 'POST', path: '/tool/set', body: { tool: 'claude' }, k8s: [200, 204], containerless: [200, 204] },
  { method: 'GET', path: '/shortcuts/get', k8s: 200, containerless: 200 },
  { method: 'POST', path: '/shortcuts/set', body: { commandId: 'x', chord: null }, k8s: [200, 204, 400], containerless: [200, 204, 400] },
  { method: 'POST', path: '/shortcuts/reset', body: {}, k8s: [200, 204], containerless: [200, 204] },
  { method: 'GET', path: '/tokens', k8s: 200, containerless: 200 },
  { method: 'POST', path: '/tokens', body: { name: 'n' }, k8s: [200, 201, 400], containerless: [200, 201, 400] },
  { method: 'DELETE', path: '/tokens/:name', request: '/tokens/nope', k8s: [200, 204, 404], containerless: [200, 204, 404] },

  // ── auth: entirely driver-neutral, credentials are the server's ───────
  { method: 'GET', path: '/auth/list', k8s: 200, containerless: 200 },
  { method: 'GET', path: '/auth/agent', k8s: [200, 503], containerless: [200, 503] },
  { method: 'POST', path: '/auth/clear', body: {}, k8s: [200, 204, 400], containerless: [200, 204, 400] },
  { method: 'POST', path: '/auth/fake', body: { kind: 'not-a-kind' }, k8s: 400, containerless: 400 },
  { method: 'PUT', path: '/auth/:tool', request: '/auth/claude', body: {}, k8s: 400, containerless: 400 },
  { method: 'POST', path: '/auth/claude/usage/refresh', body: {}, k8s: [200, 204, 400, 401, 404], containerless: [200, 204, 400, 401, 404] },
  { method: 'POST', path: '/auth/git/credentials', body: {}, k8s: 400, containerless: 400 },
  { method: 'PUT', path: '/auth/git/credentials', body: {}, k8s: 400, containerless: 400 },
  { method: 'DELETE', path: '/auth/git/credentials/:pattern', request: '/auth/git/credentials/nope', k8s: [200, 204, 404], containerless: [200, 204, 404] },
  { method: 'POST', path: '/auth/:tool/login/start', request: '/auth/claude/login/start', body: {}, k8s: [200, 400, 409, 503], containerless: [200, 400, 409, 503] },
  { method: 'GET', path: '/auth/login/:id', request: '/auth/login/nope', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/auth/login/:id/input', request: '/auth/login/nope/input', body: { input: 'x' }, k8s: [400, 404], containerless: [400, 404] },
  { method: 'POST', path: '/auth/login/:id/cancel', request: '/auth/login/nope/cancel', k8s: [200, 204, 404], containerless: [200, 204, 404] },
  { method: 'POST', path: '/auth/:tool/install/start', request: '/auth/claude/install/start', body: {}, k8s: [200, 400, 409, 503], containerless: [200, 400, 409, 503] },
  { method: 'GET', path: '/auth/install/:id', request: '/auth/install/nope', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/auth/install/:id/cancel', request: '/auth/install/nope/cancel', k8s: [200, 204, 404], containerless: [200, 204, 404] },
]

/**
 * Fail on any route the server registers that this table does not name.
 *
 * The enforcement the table needs to stay true: without it a new route
 * simply goes untested under both drivers, silently, which is the failure
 * mode a hand-maintained list always eventually has.
 */
export function assertMatrixCoversEveryRoute(): void {
  const app = buildApp({ secret: 'shh', buildId: 'matrix' })
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
