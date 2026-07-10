import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import {
  configEditProject,
  configEditDockerfile,
  configEditUserDockerfile,
} from '@/commands/config-edit'
import { editFile } from '@/commands/edit-file'
import { getRpcClient } from '@/shared/daemon-client'
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

function okJson(body: unknown): { ok: true; json: () => Promise<unknown> } {
  return { ok: true, json: () => Promise.resolve(body) }
}

/** Make the mocked $EDITOR overwrite the scratch file with `text`. */
function editorWrites(text: string): void {
  vi.mocked(editFile).mockImplementation(async (filePath: string) => {
    await fs.writeFile(filePath, text)
  })
}

describe('configEditProject', () => {
  let rawGet: ReturnType<typeof vi.fn>
  let configPut: ReturnType<typeof vi.fn>
  let configDelete: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(editFile).mockReset().mockResolvedValue(undefined)
    process.exitCode = undefined
    rawGet = vi.fn().mockResolvedValue(okJson({ content: '{\n  "env": {}\n}\n' }))
    configPut = vi.fn().mockResolvedValue(okJson({ config: {} }))
    configDelete = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    vi.mocked(getRpcClient).mockResolvedValue({
      project: {
        ':slug': {
          config: { raw: { $get: rawGet }, $put: configPut, $delete: configDelete },
        },
      },
    } as unknown as Awaited<ReturnType<typeof getRpcClient>>)
  })

  afterEach(() => {
    process.exitCode = undefined
  })

  it('fetches raw content, edits a scratch copy, and PUTs the parsed JSON', async () => {
    editorWrites('{ "env": { "FOO": "1" } }')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await configEditProject('demo')

    expect(rawGet).toHaveBeenCalledWith({ param: { slug: 'demo' } })
    const editedPath = vi.mocked(editFile).mock.calls[0][0]
    expect(editedPath).toMatch(/yaac-config\.json$/)
    expect(configPut).toHaveBeenCalledWith({
      param: { slug: 'demo' },
      json: { config: { env: { FOO: '1' } } },
    })
    expect(logSpy).toHaveBeenCalledWith('Saved project config.')
    logSpy.mockRestore()
  })

  it('makes no write when the editor leaves the content unchanged', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await configEditProject('demo')
    expect(configPut).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith('No changes.')
    logSpy.mockRestore()
  })

  it('an emptied buffer clears the config via DELETE', async () => {
    editorWrites('\n')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await configEditProject('demo')
    expect(configDelete).toHaveBeenCalledWith({ param: { slug: 'demo' } })
    expect(configPut).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('invalid JSON fails with exitCode 1 and keeps the scratch file', async () => {
    editorWrites('{ not json')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await configEditProject('demo')

    expect(process.exitCode).toBe(1)
    expect(configPut).not.toHaveBeenCalled()
    const messages = errorSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => /Invalid JSON/.test(m))).toBe(true)
    const keptPath = messages.find((m) => m.startsWith('Your edits are kept at '))
    expect(keptPath).toBeDefined()
    const tmpPath = (keptPath as string).replace('Your edits are kept at ', '')
    expect(await fs.readFile(tmpPath, 'utf8')).toBe('{ not json')
    await fs.rm(tmpPath, { force: true })
    errorSpy.mockRestore()
  })

  it('a daemon validation failure keeps the scratch file too', async () => {
    editorWrites('{ "virtualCluster": true, "nestedContainers": false }')
    configPut.mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: { code: 'VALIDATION', message: 'virtualCluster requires nestedContainers' } }),
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await configEditProject('demo')

    expect(process.exitCode).toBe(1)
    const messages = errorSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => /virtualCluster requires nestedContainers/.test(m))).toBe(true)
    expect(messages.some((m) => m.startsWith('Your edits are kept at '))).toBe(true)
    errorSpy.mockRestore()
  })

  it('propagates a NOT_FOUND before opening the editor', async () => {
    rawGet.mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: { code: 'NOT_FOUND', message: 'project nope not found' } }),
    })
    await expect(configEditProject('nope')).rejects.toThrow('project nope not found')
    expect(editFile).not.toHaveBeenCalled()
  })
})

describe('configEditDockerfile', () => {
  let get: ReturnType<typeof vi.fn>
  let put: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(editFile).mockReset().mockResolvedValue(undefined)
    process.exitCode = undefined
    get = vi.fn().mockResolvedValue(okJson({ content: '' }))
    put = vi.fn().mockResolvedValue(okJson({ content: 'RUN true\n' }))
    vi.mocked(getRpcClient).mockResolvedValue({
      project: { ':slug': { dockerfile: { $get: get, $put: put } } },
    } as unknown as Awaited<ReturnType<typeof getRpcClient>>)
  })

  it('round-trips the edited content verbatim', async () => {
    editorWrites('RUN true\n')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await configEditDockerfile('demo')

    expect(get).toHaveBeenCalledWith({ param: { slug: 'demo' } })
    expect(put).toHaveBeenCalledWith({ param: { slug: 'demo' }, json: { content: 'RUN true\n' } })
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/yaac project rebuild demo/))
    logSpy.mockRestore()
  })
})

describe('configEditUserDockerfile', () => {
  let get: ReturnType<typeof vi.fn>
  let put: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(editFile).mockReset().mockResolvedValue(undefined)
    process.exitCode = undefined
    get = vi.fn().mockResolvedValue(okJson({ content: '' }))
    put = vi.fn().mockResolvedValue(okJson({ content: 'x' }))
    vi.mocked(getRpcClient).mockResolvedValue({
      config: { 'user-dockerfile': { $get: get, $put: put } },
    } as unknown as Awaited<ReturnType<typeof getRpcClient>>)
  })

  it('edits over the config route (daemon-host file, works remotely)', async () => {
    editorWrites('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN true\n')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await configEditUserDockerfile()

    expect(get).toHaveBeenCalled()
    expect(put).toHaveBeenCalledWith({
      json: { content: 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN true\n' },
    })
    logSpy.mockRestore()
  })

  it('a rejected (non-layered) Dockerfile keeps the scratch file', async () => {
    editorWrites('FROM scratch\n')
    put.mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: { code: 'VALIDATION', message: 'user Dockerfile must be layered' } }),
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await configEditUserDockerfile()

    expect(process.exitCode).toBe(1)
    const messages = errorSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => /must be layered/.test(m))).toBe(true)
    expect(messages.some((m) => m.startsWith('Your edits are kept at '))).toBe(true)
    errorSpy.mockRestore()
  })
})
