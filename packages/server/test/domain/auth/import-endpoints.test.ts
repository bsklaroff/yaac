import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { importEmbeddedEndpoints, listAuth, loadToolAuthEntry } from '#domain/auth'
import { BUILT_IN_USER_ID, closeDb, getToolCredential, seeTailnetUser, setToolCredential } from '#db'

/**
 * Sign-ins written while each carried its own custom endpoint are moved onto
 * endpoint rows at server start (docs/legacy-compat-shims.md).
 */

const ME = BUILT_IN_USER_ID
let tmpDir: string

beforeAll(async () => {
  tmpDir = await createTempDataDir()
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('importEmbeddedEndpoints', () => {
  it('gives sign-ins sharing a URL and key one endpoint with all their models, each owner their own, once', async () => {
    const box = 'http://box.tail1234.ts.net:8080/v1'
    const legacy = (models: string[], apiKey = '', baseUrl = box) =>
      ({ kind: 'api-key' as const, provider: 'custom' as const, savedAt: 's', apiKey, endpoint: { baseUrl, models } })
    await setToolCredential(ME, 'opencode', legacy(['llama']))
    await setToolCredential(ME, 'pi', legacy(['llama', 'qwen']))
    // Same URL, another key: another endpoint, named apart.
    await setToolCredential(ME, 'omp', legacy(['llama'], 'sk-other'))
    const bob = await seeTailnetUser('bob@example.com', 'Bob')
    await setToolCredential(bob, 'pi', legacy(['m'], '', 'https://bob.example.com/v1'))

    await importEmbeddedEndpoints()
    await importEmbeddedEndpoints()

    const mine = (await listAuth(ME)).customEndpoints
    expect(mine).toMatchObject([
      { name: 'box.tail1234.ts.net', baseUrl: box, keyPreview: '', models: [{ id: 'llama' }, { id: 'qwen' }], tools: ['opencode', 'pi'] },
      { name: 'box.tail1234.ts.net-2', baseUrl: box, keyPreview: '***ther', models: [{ id: 'llama' }], tools: ['omp'] },
    ])
    expect(await getToolCredential(ME, 'pi')).toEqual({ kind: 'api-key', provider: 'custom', savedAt: 's', apiKey: '', endpointId: mine[0]?.id })
    expect(await loadToolAuthEntry(ME, 'omp')).toMatchObject({ apiKey: 'sk-other', endpoint: { id: mine[1]?.id } })
    expect((await listAuth(bob)).customEndpoints).toMatchObject([{ name: 'bob.example.com', tools: ['pi'] }])
  })
})
