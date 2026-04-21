import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { buildApp } from '@/daemon/server'
import { configOverrideDir, getProjectsDir, projectDir, claudeDir, codexDir } from '@/lib/project/paths'
import { addToken, loadCredentials } from '@/lib/project/credentials'
import {
  loadClaudeCredentialsFile,
  saveClaudeOAuthBundle,
} from '@/lib/project/tool-auth'
import { loadPreferences } from '@/lib/project/preferences'
import type * as projectAddModule from '@/lib/project/add'
import type { ProjectMeta, ClaudeOAuthBundle } from '@/shared/types'
import { DaemonError } from '@/daemon/errors'
import { makeTestRpcClient } from '@test/helpers/rpc'

vi.mock('@/daemon/session-create', () => ({
  createSession: vi.fn(),
}))

vi.mock('@/lib/session/delete', () => ({
  deleteSession: vi.fn(),
}))

vi.mock('@/lib/project/add', async () => {
  const actual = await vi.importActual<typeof projectAddModule>('@/lib/project/add')
  return {
    ...actual,
    addProject: vi.fn(),
  }
})

vi.mock('@/lib/project/remove', () => ({
  removeProject: vi.fn(),
}))

import { createSession } from '@/daemon/session-create'
import { deleteSession } from '@/lib/session/delete'
import { addProject } from '@/lib/project/add'
import { removeProject } from '@/lib/project/remove'

const mockCreateSession = vi.mocked(createSession)
const mockDeleteSession = vi.mocked(deleteSession)
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
  })

  afterEach(async () => {
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
        path.join(configOverrideDir('demo'), 'yaac-config.json'),
        'utf8',
      )
      expect(JSON.parse(raw)).toEqual({ envPassthrough: ['X'] })
    })
  })

  describe('DELETE /project/:slug/config-override', () => {
    it('returns 204 when the project exists', async () => {
      await writeProject('demo')
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug']['config-override'].$delete({ param: { slug: 'demo' } })
      expect(res.status).toBe(204)
    })

    it('returns 404 for an unknown project', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.project[':slug']['config-override'].$delete({ param: { slug: 'nope' } })
      expect(res.status).toBe(404)
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
        opts.onProgress?.('Creating container yaac-demo-sess-x...')
        return Promise.resolve({
          sessionId: 'sess-x',
          containerName: 'yaac-demo-sess-x',
          forwardedPorts: [],
          tool: 'claude',
          claimedPrewarm: false,
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
        { type: 'progress', message: 'Creating container yaac-demo-sess-x...' },
        {
          type: 'result',
          result: {
            sessionId: 'sess-x',
            containerName: 'yaac-demo-sess-x',
            forwardedPorts: [],
            tool: 'claude',
            claimedPrewarm: false,
          },
        },
      ])
      expect(mockCreateSession).toHaveBeenCalledWith('demo', expect.objectContaining({
        gitUser: { name: 'A', email: 'a@b' },
      }))
    })

    it('emits a terminal error event when createSession throws', async () => {
      mockCreateSession.mockRejectedValue(new DaemonError('VALIDATION', 'no github token'))
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.session.create.$post({ json: { project: 'demo' } })
      expect(res.status).toBe(200)
      const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as unknown)
      expect(events).toEqual([
        { type: 'error', error: { code: 'VALIDATION', message: 'no github token' } },
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
        containerName: 'yaac-demo-sess-x',
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
      expect((await loadPreferences()).defaultTool).toBe('codex')
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

  describe('POST /auth/github/tokens', () => {
    it('rejects a missing pattern', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/auth/github/tokens', withAuth({
        method: 'POST',
        body: JSON.stringify({ token: 'ghp_x' }),
      }))
      expect(res.status).toBe(400)
    })

    it('adds a token', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.auth.github.tokens.$post({
        json: { pattern: 'acme/*', token: 'ghp_new' },
      })
      expect(res.status).toBe(204)
      expect((await loadCredentials()).tokens).toEqual([
        { pattern: 'acme/*', token: 'ghp_new' },
      ])
    })

    it('surfaces invalid patterns as VALIDATION', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.auth.github.tokens.$post({
        json: { pattern: '*/*', token: 'ghp_x' },
      })
      expect(res.status).toBe(400)
    })
  })

  describe('DELETE /auth/github/tokens/:pattern', () => {
    it('removes an existing token', async () => {
      await addToken('acme/*', 'ghp_acme')
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.auth.github.tokens[':pattern'].$delete({
        param: { pattern: encodeURIComponent('acme/*') },
      })
      expect(res.status).toBe(204)
      expect((await loadCredentials()).tokens).toEqual([])
    })

    it('returns 404 for an unknown pattern', async () => {
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.auth.github.tokens[':pattern'].$delete({
        param: { pattern: 'unknown' },
      })
      expect(res.status).toBe(404)
    })
  })

  describe('PUT /auth/github/tokens', () => {
    it('replaces the entire token list', async () => {
      await addToken('old/*', 'ghp_old')
      const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
      const res = await client.auth.github.tokens.$put({
        json: { tokens: [{ pattern: 'new/*', token: 'ghp_new' }] },
      })
      expect(res.status).toBe(204)
      expect((await loadCredentials()).tokens).toEqual([
        { pattern: 'new/*', token: 'ghp_new' },
      ])
    })

    it('rejects non-array body', async () => {
      const app = buildApp({ secret: 'shh', buildId: 'test' })
      const res = await app.request('/auth/github/tokens', withAuth({
        method: 'PUT',
        body: JSON.stringify({ tokens: 'no' }),
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
