import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { addEndpoint, credentialOwnerKey, customEndpointFor, loadToolAuthEntry, removeEndpoint } from '#domain/auth'
import { BUILT_IN_USER_ID, closeDb, recordProject, seeTailnetUser, setToolCredential } from '#db'

let tmpDir: string

beforeAll(async () => {
  tmpDir = await createTempDataDir()
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('credentialOwnerKey', () => {
  it('keeps the built-in user on the key the install\'s one set was pushed under, and keys others by id', () => {
    // Registrations written before credentials were per user name `install`.
    expect(credentialOwnerKey(BUILT_IN_USER_ID)).toBe('install')
    expect(credentialOwnerKey('6f1c1c55-7a53-4bd5-9a0f-0b3a3d1b1a01')).toBe('6f1c1c55-7a53-4bd5-9a0f-0b3a3d1b1a01')
  })
})

describe('loadToolAuthEntry', () => {
  it('flattens a user\'s stored credential per tool, and reads another user\'s as none', async () => {
    const bob = await seeTailnetUser('bob@example.com', 'Bob')
    await setToolCredential(BUILT_IN_USER_ID, 'claude', {
      kind: 'oauth', savedAt: 's', claudeAiOauth: { accessToken: 'sk-ant-oat', refreshToken: 'r', expiresAt: 1, scopes: [] },
    })
    await setToolCredential(BUILT_IN_USER_ID, 'codex', { kind: 'api-key', savedAt: 's', apiKey: 'sk-proj' })
    await setToolCredential(BUILT_IN_USER_ID, 'pi', { kind: 'api-key', provider: 'anthropic', savedAt: 's', apiKey: 'sk-pi' })
    await setToolCredential(BUILT_IN_USER_ID, 'omp', { kind: 'api-key', provider: 'openrouter', savedAt: 's', apiKey: 'sk-omp' })

    expect(await loadToolAuthEntry(BUILT_IN_USER_ID, 'claude'))
      .toEqual({ tool: 'claude', kind: 'oauth', apiKey: 'sk-ant-oat', savedAt: 's' })
    expect(await loadToolAuthEntry(BUILT_IN_USER_ID, 'codex'))
      .toEqual({ tool: 'codex', kind: 'api-key', apiKey: 'sk-proj', savedAt: 's' })
    expect(await loadToolAuthEntry(BUILT_IN_USER_ID, 'pi'))
      .toEqual({ tool: 'pi', kind: 'api-key', apiKey: 'sk-pi', savedAt: 's', piProvider: 'anthropic' })
    expect(await loadToolAuthEntry(BUILT_IN_USER_ID, 'omp'))
      .toEqual({ tool: 'omp', kind: 'api-key', apiKey: 'sk-omp', savedAt: 's', ompProvider: 'openrouter' })
    expect(await loadToolAuthEntry(BUILT_IN_USER_ID, 'opencode')).toBeNull()
    expect(await loadToolAuthEntry(bob, 'claude')).toBeNull()
  })

  it('reads a custom sign-in as its endpoint, key included, and as none once the endpoint is not the owner\'s', async () => {
    const bob = await seeTailnetUser('bob@example.com', 'Bob')
    const models = [{ id: 'llama' }]
    const { id } = await addEndpoint(BUILT_IN_USER_ID, { name: 'box', baseUrl: 'https://box/v1', apiKey: 'sk-box', models })
    await setToolCredential(BUILT_IN_USER_ID, 'opencode', { kind: 'api-key', provider: 'custom', savedAt: 's', apiKey: '', endpointId: id })
    expect(await loadToolAuthEntry(BUILT_IN_USER_ID, 'opencode')).toEqual({
      tool: 'opencode', kind: 'api-key', apiKey: 'sk-box', savedAt: 's', opencodeProvider: 'custom',
      endpoint: { id, name: 'box', baseUrl: 'https://box/v1', models },
    })
    // A sign-in naming someone else's endpoint never uses it.
    await setToolCredential(bob, 'opencode', { kind: 'api-key', provider: 'custom', savedAt: 's', apiKey: '', endpointId: id })
    expect(await loadToolAuthEntry(bob, 'opencode')).toBeNull()
  })
})

describe('customEndpointFor', () => {
  it('looks up the project owner\'s endpoint only for one of its custom models', async () => {
    const project = '00000000-0000-4000-8000-0000000000f1'
    await recordProject({ id: project, name: 'p', remoteUrl: 'https://github.com/acme/p', addedAt: 'x' }, BUILT_IN_USER_ID)
    const { id } = await addEndpoint(BUILT_IN_USER_ID, { name: 'pi-box', baseUrl: 'https://pi-box/v1', models: [{ id: 'llama' }] })
    await setToolCredential(BUILT_IN_USER_ID, 'pi', { kind: 'api-key', provider: 'custom', savedAt: 's', apiKey: '', endpointId: id })

    expect(await customEndpointFor(project, 'pi', 'custom/llama')).toMatchObject({ id, models: [{ id: 'llama' }] })
    expect(await customEndpointFor(project, 'pi', 'anthropic/claude-opus-5-5')).toBeUndefined()
    expect(await customEndpointFor(project, 'claude', 'custom/llama')).toBeUndefined()
    await removeEndpoint(BUILT_IN_USER_ID, id)
    expect(await customEndpointFor(project, 'pi', 'custom/llama')).toBeUndefined()
  })
})
