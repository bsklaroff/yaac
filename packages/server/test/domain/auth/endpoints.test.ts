import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { addEndpoint, discoverEndpointModels, listAuth, loadToolAuthEntry, removeEndpoint, signInTool, updateEndpoint } from '#domain/auth'
import { BUILT_IN_USER_ID, closeDb, getToolCredential, recordProject, seeTailnetUser } from '#db'
import { getDb } from '#db/client'
import { customEndpoints, projects, toolCredentials } from '#db/schema'
import { getProjectsDir, piDir } from '@yaac/shared/project-paths'
import type { ServerError } from '@yaac/shared/errors'

/**
 * A user's custom endpoints: stored, edited, deleted with the sign-ins that
 * use them, and asked for their models. The database and project tool homes
 * are real; the endpoint is a local HTTP server answering `/models` with
 * whatever a test sets.
 */

const ME = BUILT_IN_USER_ID
const PROJECT = '00000000-0000-4000-8000-0000000000a1'
const MODELS = [{ id: 'llama' }]

/** What the stub endpoint answers next, and what it was asked. */
let answer: { status?: number; body: string }
let asked: { url: string | undefined; authorization: string | undefined }[] = []
let server: http.Server
let base: string

async function rejection(p: Promise<unknown>): Promise<ServerError> {
  try {
    await p
  } catch (err) {
    return err as ServerError
  }
  throw new Error('expected a rejection, got success')
}

let tmpDir: string

beforeAll(async () => {
  tmpDir = await createTempDataDir()
  server = http.createServer((req, res) => {
    asked.push({ url: req.url, authorization: req.headers.authorization })
    res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' })
    res.end(answer.body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await closeDb()
  await cleanupTempDir(tmpDir)
})

beforeEach(async () => {
  installFakeWorkspaceDriver({ kind: 'containerless' })
  asked = []
  const db = await getDb()
  await db.delete(toolCredentials)
  await db.delete(customEndpoints)
  await db.delete(projects)
  await fs.rm(getProjectsDir(), { recursive: true, force: true })
  await recordProject({ id: PROJECT, name: 'p', remoteUrl: 'https://github.com/acme/p', addedAt: 'x' }, ME)
})

describe('addEndpoint', () => {
  it('stores an endpoint for its owner only, its key sealed, and refuses a name the owner already uses', async () => {
    const { id } = await addEndpoint(ME, { name: 'box', baseUrl: base, apiKey: 'sk-box', models: MODELS })
    const [row] = await (await getDb()).select().from(customEndpoints)
    expect(row).toMatchObject({ id, owner: ME, name: 'box', baseUrl: base, models: MODELS })
    expect(row?.sealedApiKey).not.toContain('sk-box')
    expect((await listAuth(ME)).customEndpoints).toMatchObject([{ id, keyPreview: '***-box' }])
    const bob = await seeTailnetUser('bob@example.com', 'Bob')
    expect((await listAuth(bob)).customEndpoints).toEqual([])
    // The name is unique per owner, not per install.
    await addEndpoint(bob, { name: 'box', baseUrl: base, models: MODELS })
    expect((await rejection(addEndpoint(ME, { name: 'box', baseUrl: base, models: MODELS }))).code).toBe('CONFLICT')
  })

  it('refuses a key for a plain-HTTP endpoint on a cluster, whose proxy only sends one over https', async () => {
    installFakeWorkspaceDriver({ kind: 'k8s' })
    expect((await rejection(addEndpoint(ME, { name: 'box', baseUrl: 'http://box/v1', apiKey: 'k', models: MODELS }))).message)
      .toMatch(/never send a key over plain HTTP/)
    await addEndpoint(ME, { name: 'keyless', baseUrl: 'http://box/v1', models: MODELS })
    await addEndpoint(ME, { name: 'tls', baseUrl: 'https://box/v1', apiKey: 'k', models: MODELS })
  })
})

describe('updateEndpoint', () => {
  it('changes only what it is given, rewriting the attached tools\' config in every project at once', async () => {
    const { id } = await addEndpoint(ME, { name: 'box', baseUrl: base, apiKey: 'sk-old', models: MODELS })
    await signInTool(ME, 'pi', { kind: 'api-key', apiKey: '', provider: 'custom', endpointId: id })

    await updateEndpoint(ME, id, { models: [{ id: 'qwen', efforts: { levels: ['low', 'high'], default: 'high' } }] })
    expect(await loadToolAuthEntry(ME, 'pi')).toMatchObject({
      apiKey: 'sk-old', endpoint: { name: 'box', baseUrl: base, models: [{ id: 'qwen' }] },
    })
    const config = JSON.parse(await fs.readFile(path.join(piDir(PROJECT), 'agent', 'models.json'), 'utf8')) as {
      providers: { custom: { name: string; models: { id: string; reasoning: boolean }[] } }
    }
    expect(config.providers.custom).toMatchObject({ name: 'box', models: [{ id: 'qwen', reasoning: true }] })

    // An omitted key is kept, on the same host; an empty one removes it.
    await updateEndpoint(ME, id, { baseUrl: `${base}/` })
    expect(await loadToolAuthEntry(ME, 'pi')).toMatchObject({ apiKey: 'sk-old' })
    await updateEndpoint(ME, id, { name: 'renamed', apiKey: '' })
    expect(await loadToolAuthEntry(ME, 'pi')).toMatchObject({ apiKey: '', endpoint: { name: 'renamed' } })
  })

  it('drops the key when the host changes, unless the change gives one', async () => {
    const { id } = await addEndpoint(ME, { name: 'box', baseUrl: 'https://old.example.com/v1', apiKey: 'sk-old', models: MODELS })
    await signInTool(ME, 'pi', { kind: 'api-key', apiKey: '', provider: 'custom', endpointId: id })
    await updateEndpoint(ME, id, { baseUrl: 'https://typo.example.com/v1' })
    expect(await loadToolAuthEntry(ME, 'pi')).toMatchObject({ apiKey: '', endpoint: { baseUrl: 'https://typo.example.com/v1' } })
    await updateEndpoint(ME, id, { baseUrl: 'https://new.example.com/v1', apiKey: 'sk-new' })
    expect(await loadToolAuthEntry(ME, 'pi')).toMatchObject({ apiKey: 'sk-new' })
  })

  it('reads another user\'s endpoint as missing, and checks the key against the URL it ends up with', async () => {
    const bob = await seeTailnetUser('bob@example.com', 'Bob')
    const { id } = await addEndpoint(bob, { name: 'bobs', baseUrl: 'https://box/v1', apiKey: 'k', models: MODELS })
    expect((await rejection(updateEndpoint(ME, id, { name: 'mine' }))).code).toBe('NOT_FOUND')
    installFakeWorkspaceDriver({ kind: 'k8s' })
    expect((await rejection(updateEndpoint(bob, id, { baseUrl: 'http://box/v1' }))).message).toMatch(/plain HTTP/)
  })
})

describe('removeEndpoint', () => {
  it('deletes an endpoint in use, signing out the tools that used it and leaving the rest', async () => {
    const { id } = await addEndpoint(ME, { name: 'box', baseUrl: base, models: MODELS })
    await signInTool(ME, 'opencode', { kind: 'api-key', apiKey: '', provider: 'custom', endpointId: id })
    await signInTool(ME, 'omp', { kind: 'api-key', apiKey: '', provider: 'custom', endpointId: id })
    await signInTool(ME, 'pi', { kind: 'api-key', apiKey: 'sk-or', provider: 'openrouter' })

    expect(await removeEndpoint(ME, id)).toEqual(['opencode', 'omp'])
    expect(await getToolCredential(ME, 'opencode')).toBeNull()
    expect(await getToolCredential(ME, 'omp')).toBeNull()
    expect(await getToolCredential(ME, 'pi')).toMatchObject({ provider: 'openrouter' })
    expect((await listAuth(ME)).customEndpoints).toEqual([])
    expect((await rejection(removeEndpoint(ME, id))).code).toBe('NOT_FOUND')
  })
})

describe('discoverEndpointModels', () => {
  it('lists an OpenAI-style answer\'s models, with Codex\'s reasoning fields wherever llama-swap puts them', async () => {
    answer = { body: JSON.stringify({ object: 'list', data: [
      // Codex's catalog shape, on the entry itself.
      {
        id: 'gpt-oss-120b', name: 'gpt-oss 120B',
        supported_reasoning_levels: [{ effort: 'low', description: 'fast' }, { effort: 'high' }, { effort: 'ultra' }],
        default_reasoning_level: 'high',
      },
      // llama-swap passes a model's `metadata` through under meta.llamaswap.
      { id: 'qwen3', meta: { llamaswap: { supported_reasoning_levels: ['high', 'medium', 'low'] } } },
      { id: 'gemma' },
      { id: 'nomic-embed', capabilities: { embeddings: true } },
      { id: 'bad id;rm -rf ~' },
      { id: 'gemma' },
    ] }) }
    expect(await discoverEndpointModels(ME, { baseUrl: `${base}/` })).toEqual({
      models: [
        { id: 'gpt-oss-120b', name: 'gpt-oss 120B', efforts: { levels: ['low', 'high'], default: 'high' } },
        // No default given: medium, which it lists.
        { id: 'qwen3', efforts: { levels: ['low', 'medium', 'high'], default: 'medium' } },
        { id: 'gemma' },
      ],
      skipped: [
        { id: 'nomic-embed', reason: 'not a chat model' },
        { id: 'bad id;rm -rf ~', reason: expect.stringMatching(/a model id is letters/) as unknown },
      ],
    })
    expect(asked).toEqual([{ url: '/v1/models', authorization: undefined }])
  })

  it('asks a stored endpoint with its own URL and key, and only its owner\'s', async () => {
    answer = { body: JSON.stringify({ data: [{ id: 'llama' }] }) }
    const { id } = await addEndpoint(ME, { name: 'box', baseUrl: base, apiKey: 'sk-box', models: MODELS })
    expect((await discoverEndpointModels(ME, { endpointId: id })).models).toEqual([{ id: 'llama' }])
    expect(asked.at(-1)?.authorization).toBe('Bearer sk-box')
    await discoverEndpointModels(ME, { baseUrl: base, apiKey: 'sk-typed' })
    expect(asked.at(-1)?.authorization).toBe('Bearer sk-typed')
    const bob = await seeTailnetUser('bob@example.com', 'Bob')
    expect((await rejection(discoverEndpointModels(bob, { endpointId: id }))).code).toBe('NOT_FOUND')
  })

  it('says why a fetch timed out in the in-cluster server, whose egress drops private addresses', async () => {
    // A server that takes the connection and never answers stands in for a
    // dial the policy drops.
    const silent = http.createServer(() => { /* never answers */ })
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(silent.address() as AddressInfo).port}/v1`
    vi.stubEnv('YAAC_IN_CLUSTER', '1')
    try {
      expect((await rejection(discoverEndpointModels(ME, { baseUrl: url }))).message).toMatch(
        /did not list its models: .*timeout \(the in-cluster yaac server reaches only public addresses.*--models-file/,
      )
    } finally {
      vi.unstubAllEnvs()
      silent.closeAllConnections()
      await new Promise((resolve) => silent.close(resolve))
    }
  }, 30_000)

  it('says what went wrong when the endpoint does not answer with a model list', async () => {
    const fails = async (): Promise<string> => (await rejection(discoverEndpointModels(ME, { baseUrl: base }))).message
    answer = { status: 401, body: '{"error":"no key"}' }
    expect(await fails()).toBe(`${base}/models did not list its models: HTTP 401 Unauthorized`)
    answer = { body: '<html>' }
    expect(await fails()).toMatch(/did not answer with JSON/)
    answer = { body: '{"models":[]}' }
    expect(await fails()).toMatch(/did not answer with a model list/)
    answer = { body: `{"data":[${'{"id":"m"},'.repeat(250_000)}{"id":"m"}]}` }
    expect(await fails()).toMatch(/larger than 2 MiB/)
    // A port nothing listens on any more.
    const closed = http.createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise((resolve) => closed.close(resolve))
    expect((await rejection(discoverEndpointModels(ME, { baseUrl: `http://127.0.0.1:${port}/v1` }))).message)
      .toMatch(/did not list its models: .*ECONNREFUSED/)
  })
})
