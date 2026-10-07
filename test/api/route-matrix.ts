import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { buildApp } from '@yaac/server/main/server'
import { closeDb, getDb } from '@yaac/server/db/client'
import { draftWorkspaces, gitCredentials, queuedWorkspaces } from '@yaac/server/db/schema'
import { recordWorkspaceCreated } from '@yaac/server/db/workspace-store'
import { insertQueuedWorkspace } from '@yaac/server/db/queued-workspace-store'
import { insertDraftWorkspace } from '@yaac/server/db/draft-workspace-store'
import { BUILT_IN_USER_ID, insertGitCredential } from '@yaac/server/db'
import { clearAllProvisioningForTests, registerProvisioning } from '@yaac/server/domain/workspaces/provisioning'
import { registerImageBuild } from '@yaac/server/drivers/k8s/image-engine/image-builds'
import { recordTestProject } from '@yaac/test-utils/project-fixture'
import { asTailnet } from '@yaac/test-utils/api'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import type { DriverKind } from '@yaac/shared/types'

/**
 * Every route the server registers, and what each driver answers for it.
 *
 * One table with a column per driver, so each route states both answers on
 * one line and any difference must be written out with a `why`.
 * `assertMatrixCoversEveryRoute` fails on any registered route the table
 * does not name.
 *
 * Each row also states who may call it (`access`), which
 * `assertNonOwnerRefused` checks as a second user against a server holding
 * another user's project. Otherwise it checks only the status a caller gets
 * from a server with no projects or workspaces. Behavior is covered by
 * `write-routes.test.ts` and the e2e tiers.
 */

/** What a route answers. A number is exact; an array is "one of these". */
export type Expected = number | number[]

/**
 * Who may call a route (docs/plans/multi-user-deployment.md
 * "Authorization"). `public` never consults the caller; `reader` is any
 * user; `owner` is the owner of what the route names, refused to anyone
 * else with 403.
 */
export type Access = 'public' | 'reader' | 'owner'

export interface RouteCase {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Exactly as Hono registered it, params and all. */
  path: string
  /** Concrete path to request, naming the `ID` fixtures where it names
   *  anything: missing on the empty server, another user's in the
   *  non-owner check. */
  request?: string
  body?: unknown
  access: Access
  /** An `owner` route that acts only on the caller's own data, so there is
   *  nothing of another user's for the non-owner check to name. */
  callerScoped?: true
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
 * What the requests name. None exists on the empty server; `seedOwnedFixtures`
 * creates each under another user's project.
 */
export const ID = {
  project: '5e1f0c2a-7b3d-4e8f-9a6c-0d1e2f3a4b5c',
  workspace: '6f2a1d3b-8c4e-4f9a-8b7d-1e2f3a4b5c6d',
  queued: '7a3b2e4c-9d5f-4a0b-8c8e-2f3a4b5c6d7e',
  draft: '8b4c3f5d-0e6a-4b1c-9d9f-3a4b5c6d7e8f',
  provisioning: '9c5d4a6e-1f7b-4c2d-8e0a-4b5c6d7e8f9a',
  group: 'g1',
  credential: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  // The first id the build feed hands out in a fresh process.
  build: 'build-1',
} as const

const P = `/api/project/${ID.project}`
const W = `/api/workspace/${ID.workspace}`

/**
 * The table, grouped as the routes are. Most routes answer identically
 * under both drivers; the differences are features a host install lacks.
 */
export const ROUTE_MATRIX: RouteCase[] = [
  // ── health and identity ───────────────────────────────────────────────
  { method: 'GET', path: '/api/health', access: 'public', k8s: 200, containerless: 200 },
  { method: 'GET', path: '/api/whoami', access: 'reader', k8s: 200, containerless: 200 },

  // ── projects ──────────────────────────────────────────────────────────
  { method: 'GET', path: '/api/project/list', access: 'reader', k8s: 200, containerless: 200 },
  // Both create a project the caller then owns.
  { method: 'POST', path: '/api/project/add', body: { url: 'not a url' }, access: 'owner', callerScoped: true, k8s: 400, containerless: 400 },
  { method: 'POST', path: '/api/project/register', body: {}, access: 'owner', callerScoped: true, k8s: 400, containerless: 400 },
  { method: 'GET', path: '/api/project/:projectId', request: P, access: 'reader', k8s: MISSING, containerless: MISSING },
  { method: 'DELETE', path: '/api/project/:projectId', request: P, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'PUT', path: '/api/project/:projectId/git-credential', request: `${P}/git-credential`, body: { credentialId: ID.credential }, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/project/:projectId/config', request: `${P}/config`, access: 'reader', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/project/:projectId/config/raw', request: `${P}/config/raw`, access: 'reader', k8s: MISSING, containerless: MISSING },
  { method: 'PUT', path: '/api/project/:projectId/config', request: `${P}/config`, body: { config: {} }, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'DELETE', path: '/api/project/:projectId/config', request: `${P}/config`, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/project/:projectId/env', request: `${P}/env`, access: 'reader', k8s: MISSING, containerless: MISSING },
  { method: 'PUT', path: '/api/project/:projectId/env', request: `${P}/env`, body: { name: 'A', value: '1' }, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'DELETE', path: '/api/project/:projectId/env/:id', request: `${P}/env/abc`, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/project/:projectId/branches', request: `${P}/branches`, access: 'reader', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/project/:projectId/skills', request: `${P}/skills`, access: 'reader', k8s: OK_OR_MISSING, containerless: OK_OR_MISSING },
  { method: 'GET', path: '/api/project/:projectId/skills/body', request: `${P}/skills/body?path=x`, access: 'reader', k8s: [200, 400, 404], containerless: [200, 400, 404] },

  // ── images: the project's build inputs ────────────────────────────────
  // A containerless server builds no images, so these refuse rather than
  // answer empty.
  { method: 'GET', path: '/api/project/:projectId/dockerfile', request: `${P}/dockerfile`, access: 'reader', why: 'builds no images', k8s: MISSING, containerless: UNSUPPORTED },
  { method: 'PUT', path: '/api/project/:projectId/dockerfile', request: `${P}/dockerfile`, body: { content: '' }, access: 'owner', why: 'builds no images', k8s: MISSING, containerless: UNSUPPORTED },
  { method: 'GET', path: '/api/project/:projectId/build-files', request: `${P}/build-files`, access: 'reader', why: 'builds no images', k8s: OK_OR_MISSING, containerless: UNSUPPORTED },
  { method: 'GET', path: '/api/project/:projectId/build-files/file', request: `${P}/build-files/file?path=a`, access: 'reader', why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'PUT', path: '/api/project/:projectId/build-files/file', request: `${P}/build-files/file`, body: { path: 'a', content: '' }, access: 'owner', why: 'builds no images', k8s: MISSING, containerless: UNSUPPORTED },
  { method: 'POST', path: '/api/project/:projectId/build-files/rename', request: `${P}/build-files/rename`, body: { from: 'a', to: 'b' }, access: 'owner', why: 'builds no images', k8s: MISSING, containerless: UNSUPPORTED },
  { method: 'DELETE', path: '/api/project/:projectId/build-files/file', request: `${P}/build-files/file?path=a`, access: 'owner', why: 'builds no images', k8s: MISSING, containerless: UNSUPPORTED },
  // The caller's own settings: the git identity their workspaces commit
  // under and the zone they run in (every substrate needs both), and the
  // Dockerfile.user topping their projects' images.
  { method: 'GET', path: '/api/config/git-identity', access: 'owner', callerScoped: true, k8s: 200, containerless: 200 },
  { method: 'PUT', path: '/api/config/git-identity', body: { name: 'A', email: 'a@b.co' }, access: 'owner', callerScoped: true, k8s: 200, containerless: 200 },
  { method: 'GET', path: '/api/config/time-zone', access: 'owner', callerScoped: true, k8s: 200, containerless: 200 },
  { method: 'PUT', path: '/api/config/time-zone', body: { timeZone: 'America/New_York' }, access: 'owner', callerScoped: true, k8s: 200, containerless: 200 },
  { method: 'GET', path: '/api/config/user-dockerfile', access: 'owner', callerScoped: true, why: 'builds no images', k8s: 200, containerless: UNSUPPORTED },
  { method: 'PUT', path: '/api/config/user-dockerfile', body: { content: '' }, access: 'owner', callerScoped: true, why: 'builds no images', k8s: 200, containerless: UNSUPPORTED },
  { method: 'GET', path: '/api/config/user-build-files', access: 'owner', callerScoped: true, why: 'builds no images', k8s: 200, containerless: UNSUPPORTED },
  { method: 'GET', path: '/api/config/user-build-files/file', request: '/api/config/user-build-files/file?path=a', access: 'owner', callerScoped: true, why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'PUT', path: '/api/config/user-build-files/file', body: { path: 'a', content: '' }, access: 'owner', callerScoped: true, why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'POST', path: '/api/config/user-build-files/rename', body: { from: 'a', to: 'b' }, access: 'owner', callerScoped: true, why: 'builds no images', k8s: [200, 400, 404], containerless: UNSUPPORTED },
  { method: 'DELETE', path: '/api/config/user-build-files/file', request: '/api/config/user-build-files/file?path=a', access: 'owner', callerScoped: true, why: 'builds no images', k8s: [200, 204, 400, 404], containerless: UNSUPPORTED },

  // ── images: the build feed ────────────────────────────────────────────
  // The driver answers `[]` so the snapshot keeps rendering, but the route
  // refuses: `[]` would mean "no builds running", not "never builds". A
  // shared image's build is anyone's to retry or dismiss; the non-owner
  // check names a project layer's.
  { method: 'GET', path: '/api/image/builds', access: 'reader', why: 'builds no images', k8s: 200, containerless: UNSUPPORTED },
  { method: 'GET', path: '/api/image/builds/:id/log', request: `/api/image/builds/${ID.build}/log`, access: 'reader', why: 'builds no images', k8s: MISSING, containerless: UNSUPPORTED },
  { method: 'DELETE', path: '/api/image/builds/:id', request: `/api/image/builds/${ID.build}`, access: 'owner', why: 'builds no images', k8s: 204, containerless: UNSUPPORTED },
  { method: 'POST', path: '/api/image/builds/:id/retry', request: `/api/image/builds/${ID.build}/retry`, access: 'owner', why: 'builds no images', k8s: MISSING, containerless: UNSUPPORTED },

  // ── workspaces: the driver-neutral half ────────────────────────────────
  { method: 'GET', path: '/api/workspace/list', access: 'reader', k8s: [200, 503], containerless: 200 },
  { method: 'GET', path: '/api/workspace/list-stopped', access: 'reader', k8s: 200, containerless: 200 },
  { method: 'POST', path: '/api/workspace/create', body: { project: ID.project }, access: 'owner', k8s: MISSING, containerless: MISSING },
  // An unknown workspace is a plain 404; later failures travel in the
  // NDJSON stream.
  { method: 'POST', path: '/api/workspace/restart', body: { workspaceId: ID.workspace }, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/stop', body: { workspaceId: ID.workspace }, access: 'owner', k8s: [404, 503], containerless: MISSING },
  { method: 'POST', path: '/api/workspace/mark-death-seen', body: { projectId: ID.project, workspaceId: ID.workspace }, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/mark-all-deaths-seen', body: { projectId: ID.project }, access: 'owner', k8s: MISSING, containerless: MISSING },
  // The in-workspace command channel, authenticated by the calling
  // workspace's own credential rather than a user. Containerless answers 401
  // because the matrix sends no workspace bearer token.
  { method: 'POST', path: '/api/workspace/mama', body: { command: 'list' }, access: 'public',
    why: 'the egress proxy relays a pod\'s yaac-mama calls to a listener of their own',
    k8s: UNSUPPORTED, containerless: 401 },
  { method: 'POST', path: '/api/workspace/queue/create', body: { project: ID.project, parent: ID.workspace, prompt: 'p' }, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/queue/update', body: { id: ID.queued, prompt: 'p' }, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/queue/discard', body: { id: ID.queued }, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/queue/run', body: { id: ID.queued }, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/draft/save', body: { project: ID.project, prompt: 'p', tool: 'claude', mode: 'tui', permissionMode: 'manual' }, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/draft/discard', body: { id: ID.draft }, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/workspace/group/list', access: 'reader', k8s: 200, containerless: 200 },
  { method: 'POST', path: '/api/workspace/group/create', body: { projectId: ID.project, name: 'g' }, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/group/move', body: { projectId: ID.project, workspaceId: ID.workspace, group: null }, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/group/rename', body: { projectId: ID.project, groupId: ID.group, name: 'g' }, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/group/set-pinned', body: { projectId: ID.project, groupId: ID.group, pinned: true }, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/group/delete', body: { projectId: ID.project, groupId: ID.group }, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/set-group', body: { projectId: ID.project, workspaceId: ID.workspace, groupId: null }, access: 'owner', k8s: MISSING, containerless: MISSING },
  // Idempotent for an id with no entry.
  { method: 'POST', path: '/api/workspace/provisioning/:id/dismiss', request: `/api/workspace/provisioning/${ID.provisioning}/dismiss`, access: 'owner', k8s: 204, containerless: 204 },
  { method: 'POST', path: '/api/workspace/:id/title', request: `${W}/title`, body: { title: 't' }, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/workspace/:id', request: W, access: 'reader', k8s: [404, 503], containerless: MISSING },
  { method: 'GET', path: '/api/workspace/:id/agent-sessions', request: `${W}/agent-sessions`, access: 'reader', k8s: MISSING, containerless: MISSING },
  // Reads recorded state and host files, so both drivers agree. Its 501 is
  // for a tool (opencode) whose history lives in the container.
  { method: 'GET', path: '/api/workspace/:id/agent-sessions/:sessionId/transcript', request: `${W}/agent-sessions/s1/transcript`, access: 'reader', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/workspace/:id/changes', request: `${W}/changes`, access: 'reader', k8s: [404, 503], containerless: MISSING },
  // Run git inside the running workspace: 409 when stopped, 404 when
  // unknown.
  { method: 'GET', path: '/api/workspace/:id/git-status', request: `${W}/git-status`, access: 'reader', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/workspace/:id/files', request: `${W}/files`, access: 'reader', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/workspace/:id/file-at', request: `${W}/file-at?path=a&rev=${'0'.repeat(40)}`, access: 'reader', k8s: MISSING, containerless: MISSING },
  // The rest of the file editor reads the checkout on the server's disk, so
  // it needs no running workspace.
  { method: 'GET', path: '/api/workspace/:id/dir', request: `${W}/dir?path=a`, access: 'reader', k8s: MISSING, containerless: MISSING },
  { method: 'GET', path: '/api/workspace/:id/file', request: `${W}/file?path=a`, access: 'reader', k8s: MISSING, containerless: MISSING },
  { method: 'PUT', path: '/api/workspace/:id/file', request: `${W}/file`, body: { path: 'a', content: '', baseVersion: null }, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'DELETE', path: '/api/workspace/:id/file', request: `${W}/file?path=a`, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/:id/folder', request: `${W}/folder`, body: { path: 'a' }, access: 'owner', k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/workspace/:id/rename', request: `${W}/rename`, body: { from: 'a', to: 'b' }, access: 'owner', k8s: MISSING, containerless: MISSING },
  // Recorded state, so no running workspace (and no 503) is involved.
  { method: 'GET', path: '/api/workspace/:id/prompt', request: `${W}/prompt`, access: 'reader', k8s: [200, 404], containerless: [200, 404] },
  // An image pasted into a terminal pane; needs a running workspace.
  { method: 'POST', path: '/api/workspace/:id/attachments', request: `${W}/attachments`, access: 'owner', k8s: [404, 503], containerless: MISSING },
  { method: 'POST', path: '/api/workspace/:id/terminals', request: `${W}/terminals`, access: 'owner', k8s: [404, 409, 503], containerless: MISSING },
  { method: 'POST', path: '/api/workspace/:id/terminals/close', request: `${W}/terminals/close`, body: { target: 'window:@1' }, access: 'owner', k8s: [404, 409, 503], containerless: MISSING },

  // ── workspaces: egress and the port relay ──────────────────────────────
  // The feature guard runs before the id lookup, so the refusal doesn't
  // depend on the workspace existing.
  { method: 'GET', path: '/api/workspace/:id/blocked-hosts', request: `${W}/blocked-hosts`, access: 'reader', why: 'mediates no egress', k8s: [404, 503], containerless: UNSUPPORTED },
  { method: 'POST', path: '/api/workspace/:id/allow-host', request: `${W}/allow-host`, body: { host: 'example.com' }, access: 'owner', why: 'mediates no egress', k8s: [404, 503], containerless: UNSUPPORTED },
  { method: 'POST', path: '/api/workspace/:id/forward-port', request: `${W}/forward-port`, body: { containerPort: 3000 }, access: 'owner', why: 'relays no ports', k8s: [404, 503], containerless: UNSUPPORTED },
  { method: 'POST', path: '/api/workspace/:id/dismiss-port', request: `${W}/dismiss-port`, body: { containerPort: 3000 }, access: 'owner', why: 'relays no ports', k8s: [404, 503], containerless: UNSUPPORTED },

  // ── shortcuts: the caller's own ───────────────────────────────────────
  { method: 'GET', path: '/api/shortcuts/get', access: 'owner', callerScoped: true, k8s: 200, containerless: 200 },
  { method: 'POST', path: '/api/shortcuts/set', body: { commandId: 'x', chord: null }, access: 'owner', callerScoped: true, k8s: [200, 204, 400], containerless: [200, 204, 400] },
  { method: 'POST', path: '/api/shortcuts/reset', body: {}, access: 'owner', callerScoped: true, k8s: [200, 204], containerless: [200, 204] },

  // ── auth: driver-neutral, and each caller's own credentials ───────────
  { method: 'GET', path: '/api/auth/list', access: 'owner', callerScoped: true, k8s: 200, containerless: 200 },
  { method: 'GET', path: '/api/auth/agent', access: 'owner', callerScoped: true, k8s: [200, 503], containerless: [200, 503] },
  { method: 'POST', path: '/api/auth/clear', body: {}, access: 'owner', callerScoped: true, k8s: [200, 204, 400], containerless: [200, 204, 400] },
  { method: 'POST', path: '/api/auth/fake', body: { kind: 'not-a-kind' }, access: 'owner', callerScoped: true, k8s: 400, containerless: 400 },
  { method: 'PUT', path: '/api/auth/:tool', request: '/api/auth/claude', body: {}, access: 'owner', callerScoped: true, k8s: 400, containerless: 400 },
  { method: 'POST', path: '/api/auth/claude/usage/refresh', body: {}, access: 'owner', callerScoped: true, k8s: [200, 204, 400, 401, 404], containerless: [200, 204, 400, 401, 404] },
  { method: 'POST', path: '/api/auth/git/credentials', body: {}, access: 'owner', callerScoped: true, k8s: 400, containerless: 400 },
  { method: 'POST', path: '/api/auth/git/ssh-keys', body: {}, access: 'owner', callerScoped: true, k8s: 400, containerless: 400 },
  { method: 'PATCH', path: '/api/auth/git/credentials/:id', request: `/api/auth/git/credentials/${ID.credential}`, body: { name: 'x' }, access: 'owner', callerScoped: true, k8s: 404, containerless: 404 },
  { method: 'POST', path: '/api/auth/git/credentials/:id/replace', request: `/api/auth/git/credentials/${ID.credential}/replace`, body: { token: 'x' }, access: 'owner', callerScoped: true, k8s: 404, containerless: 404 },
  { method: 'DELETE', path: '/api/auth/git/credentials/:id', request: `/api/auth/git/credentials/${ID.credential}`, access: 'owner', callerScoped: true, k8s: 404, containerless: 404 },
  { method: 'POST', path: '/api/auth/:tool/login/start', request: '/api/auth/claude/login/start', body: {}, access: 'owner', callerScoped: true, k8s: [200, 400, 409, 503], containerless: [200, 400, 409, 503] },
  { method: 'GET', path: '/api/auth/login/:id', request: '/api/auth/login/nope', access: 'owner', callerScoped: true, k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/auth/login/:id/input', request: '/api/auth/login/nope/input', body: { input: 'x' }, access: 'owner', callerScoped: true, k8s: [400, 404], containerless: [400, 404] },
  { method: 'POST', path: '/api/auth/login/:id/cancel', request: '/api/auth/login/nope/cancel', access: 'owner', callerScoped: true, k8s: [200, 204, 404], containerless: [200, 204, 404] },
  { method: 'POST', path: '/api/auth/:tool/install/start', request: '/api/auth/claude/install/start', body: {}, access: 'owner', callerScoped: true, k8s: [200, 400, 409, 503], containerless: [200, 400, 409, 503] },
  { method: 'GET', path: '/api/auth/install/:id', request: '/api/auth/install/nope', access: 'owner', callerScoped: true, k8s: MISSING, containerless: MISSING },
  { method: 'POST', path: '/api/auth/install/:id/cancel', request: '/api/auth/install/nope/cancel', access: 'owner', callerScoped: true, k8s: [200, 204, 404], containerless: [200, 204, 404] },
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

/** Request a case from `app`, as the caller `headers` make it. */
export async function requestRoute(
  app: ReturnType<typeof buildApp>,
  route: RouteCase,
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = { method: route.method, headers: { ...headers } }
  if (route.body !== undefined) {
    init.body = JSON.stringify(route.body)
    init.headers = { ...headers, 'Content-Type': 'application/json' }
  }
  return await app.request(route.request ?? route.path, init)
}

/** The tailnet name the non-owner check's requests arrive at. Its test
 *  must admit it through `YAAC_ALLOWED_HOSTS`. */
export const TAILNET_HOST = 'srv.tailnet.ts.net'

/** A second user: what `tailscale serve` stamps on a teammate's request. */
export const asTeammate = (): Record<string, string> => asTailnet('teammate@example.com', TAILNET_HOST)

/**
 * Give the built-in user a project holding everything `ID` names, so a
 * request as anyone else names another user's things. The group needs no
 * row: its routes refuse on the project before looking it up.
 */
export async function seedOwnedFixtures(): Promise<void> {
  await recordTestProject(ID.project)
  await recordWorkspaceCreated({ projectId: ID.project, workspaceId: ID.workspace })
  const settings = { prompt: 'p', tool: 'claude', mode: 'tui', permissionMode: 'manual' } as const
  const db = await getDb()
  const queued = await insertQueuedWorkspace(ID.project, { parentWorkspaceId: ID.workspace }, { ...settings, model: 'm', branch: 'main' })
  await db.update(queuedWorkspaces).set({ id: ID.queued }).where(eq(queuedWorkspaces.id, queued.id))
  const draft = await insertDraftWorkspace(ID.project, settings)
  await db.update(draftWorkspaces).set({ id: ID.draft }).where(eq(draftWorkspaces.id, draft.id))
  const credential = await insertGitCredential({ owner: BUILT_IN_USER_ID, name: 'gh', kind: 'https', secret: 'ghp_x' })
  await db.update(gitCredentials).set({ id: ID.credential }).where(eq(gitCredentials.id, credential.id))
  registerProvisioning({ workspaceId: ID.provisioning, projectId: ID.project, tool: 'claude', kind: 'create' })
  // Only a k8s server lists it; a containerless one never asks.
  expect(registerImageBuild({ tag: `yaac-proj-${ID.project}:x`, layer: 'project', projectId: ID.project, reason: 'prewarm' }))
    .toBe(ID.build)
}

/**
 * Every route as a teammate, against a server holding another user's
 * project (`seedOwnedFixtures`): an `owner` route refuses with 403, unless
 * this substrate refuses the feature first, and a `reader` route admits
 * them. Caller-scoped routes act on the caller's own data, so they are
 * skipped, except that another user's git credential must read as missing.
 * A tailnet server, so the second user is just request headers.
 */
export function describeNonOwner(kind: DriverKind): void {
  describe(`every route as a non-owner, ${kind}`, () => {
    let tmpDir: string
    const app = (): ReturnType<typeof buildApp> => buildApp({ buildId: 'matrix', access: () => 'tailnet' })

    beforeAll(async () => {
      vi.stubEnv('YAAC_ALLOWED_HOSTS', TAILNET_HOST)
      await closeDb()
      tmpDir = await createTempDataDir()
      await seedOwnedFixtures()
    })
    afterAll(async () => {
      vi.unstubAllEnvs()
      clearAllProvisioningForTests()
      await closeDb()
      await cleanupTempDir(tmpDir)
    })

    for (const route of ROUTE_MATRIX.filter((r) => r.access === 'owner' && !r.callerScoped)) {
      const want = (kind === 'k8s' ? route.k8s : route.containerless) === UNSUPPORTED ? UNSUPPORTED : 403
      it(`${label(route)} refuses another user's (${String(want)})`, async () => {
        const res = await requestRoute(app(), route, asTeammate())
        expect(res.status, await res.text()).toBe(want)
      })
    }

    it('answers another user\'s git credential as missing', async () => {
      for (const route of ROUTE_MATRIX.filter((r) => r.request?.includes(ID.credential))) {
        const res = await requestRoute(app(), route, asTeammate())
        expect(res.status, label(route)).toBe(404)
      }
    })

    it('admits a non-owner to every reader route', async () => {
      for (const route of ROUTE_MATRIX.filter((r) => r.access === 'reader')) {
        const res = await requestRoute(app(), route, asTeammate())
        expect([401, 403], `${label(route)} → ${String(res.status)}`).not.toContain(res.status)
      }
    })
  })
}
