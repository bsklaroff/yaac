import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'
import { editProjectConfigFile, configEditUserDockerfile } from '@/commands/config-edit'
import { editFile } from '@/commands/edit-file'
import { getRpcClient } from '@/shared/daemon-client'
import { getDataDir, projectConfigDir } from '@/shared/paths'
import type * as daemonClientModule from '@/shared/daemon-client'

vi.mock('@/commands/edit-file', () => ({
  editFile: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/shared/daemon-client', async (importOriginal) => {
  const actual = await importOriginal<typeof daemonClientModule>()
  return {
    ...actual,
    getRpcClient: vi.fn(),
    toClientError: vi.fn().mockImplementation(async (res: Response) => {
      const body = await res.json() as { error?: { message?: string } }
      return new Error(body.error?.message ?? `daemon ${res.status}`)
    }),
  }
})

function mockExistsResponse(res: { ok: boolean; status?: number; body?: unknown }): ReturnType<typeof vi.fn> {
  const get = vi.fn().mockResolvedValue({
    ok: res.ok,
    status: res.status ?? 200,
    json: () => Promise.resolve(res.body ?? {}),
  })
  vi.mocked(getRpcClient).mockResolvedValue({
    project: { ':slug': { exists: { $get: get } } },
  } as unknown as Awaited<ReturnType<typeof getRpcClient>>)
  return get
}

describe('editProjectConfigFile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens the named file under the project config dir after the exists check', async () => {
    const get = mockExistsResponse({ ok: true })

    await editProjectConfigFile('demo', 'yaac-config.json')

    expect(get).toHaveBeenCalledWith({ param: { slug: 'demo' } })
    expect(editFile).toHaveBeenCalledWith(path.join(projectConfigDir('demo'), 'yaac-config.json'))
  })

  it('resolves the Dockerfile.yaac path from the same helper', async () => {
    mockExistsResponse({ ok: true })

    await editProjectConfigFile('demo', 'Dockerfile.yaac')

    expect(editFile).toHaveBeenCalledWith(path.join(projectConfigDir('demo'), 'Dockerfile.yaac'))
  })

  it('throws without opening the editor when the project does not exist', async () => {
    mockExistsResponse({
      ok: false,
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'project nope not found' } },
    })

    await expect(editProjectConfigFile('nope', 'yaac-config.json'))
      .rejects.toThrow('project nope not found')
    expect(editFile).not.toHaveBeenCalled()
  })
})

describe('configEditUserDockerfile', () => {
  it('opens the global Dockerfile.user without a daemon round-trip', async () => {
    vi.clearAllMocks()

    await configEditUserDockerfile()

    expect(getRpcClient).not.toHaveBeenCalled()
    expect(editFile).toHaveBeenCalledWith(path.join(getDataDir(), 'Dockerfile.user'))
  })
})
