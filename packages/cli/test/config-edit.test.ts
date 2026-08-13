import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import {
  configEditProject,
  configEditDockerfile,
  configEditUserDockerfile,
} from '#commands/config-edit'
import { editFile } from '#commands/edit-file'
import { ServerError } from '@yaac/shared/errors'

vi.mock('#commands/edit-file', () => ({
  editFile: vi.fn().mockResolvedValue(undefined),
}))

// The commands use the shared `api` singleton, which resolves each request to
// its already-unwrapped body (reads) or undefined (void writes). Mock the
// singleton with a leaf fn per route.
const h = vi.hoisted(() => ({
  rawGet: vi.fn(),
  configPut: vi.fn(),
  configDelete: vi.fn(),
  dockerGet: vi.fn(),
  dockerPut: vi.fn(),
  userGet: vi.fn(),
  userPut: vi.fn(),
}))

vi.mock('#commands/api', () => ({
  api: {
    project: {
      ':slug': {
        config: { raw: { $get: h.rawGet }, $put: h.configPut, $delete: h.configDelete },
        dockerfile: { $get: h.dockerGet, $put: h.dockerPut },
      },
    },
    config: { 'user-dockerfile': { $get: h.userGet, $put: h.userPut } },
  },
}))

/** Make the mocked $EDITOR overwrite the scratch file with `text`. */
function editorWrites(text: string): void {
  vi.mocked(editFile).mockImplementation(async (filePath: string) => {
    await fs.writeFile(filePath, text)
  })
}

describe('configEditProject', () => {
  const { rawGet, configPut, configDelete } = h

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(editFile).mockReset().mockResolvedValue(undefined)
    process.exitCode = undefined
    rawGet.mockResolvedValue({ content: '{\n  "env": {}\n}\n' })
    configPut.mockResolvedValue(undefined)
    configDelete.mockResolvedValue(undefined)
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

  it('a server validation failure keeps the scratch file too', async () => {
    editorWrites('{ "virtualCluster": true, "nestedContainers": false }')
    configPut.mockRejectedValue(new ServerError('VALIDATION', 'virtualCluster requires nestedContainers'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await configEditProject('demo')

    expect(process.exitCode).toBe(1)
    const messages = errorSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => /virtualCluster requires nestedContainers/.test(m))).toBe(true)
    expect(messages.some((m) => m.startsWith('Your edits are kept at '))).toBe(true)
    errorSpy.mockRestore()
  })

  it('propagates a NOT_FOUND before opening the editor', async () => {
    rawGet.mockRejectedValue(new ServerError('NOT_FOUND', 'project nope not found'))
    await expect(configEditProject('nope')).rejects.toThrow('project nope not found')
    expect(editFile).not.toHaveBeenCalled()
  })
})

describe('configEditDockerfile', () => {
  const { dockerGet: get, dockerPut: put } = h

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(editFile).mockReset().mockResolvedValue(undefined)
    process.exitCode = undefined
    get.mockResolvedValue({ content: '' })
    put.mockResolvedValue(undefined)
  })

  it('round-trips the edited content verbatim', async () => {
    editorWrites('RUN true\n')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await configEditDockerfile('demo')

    expect(get).toHaveBeenCalledWith({ param: { slug: 'demo' } })
    expect(put).toHaveBeenCalledWith({ param: { slug: 'demo' }, json: { content: 'RUN true\n' } })
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/next worktree created/))
    logSpy.mockRestore()
  })
})

describe('configEditUserDockerfile', () => {
  const { userGet: get, userPut: put } = h

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(editFile).mockReset().mockResolvedValue(undefined)
    process.exitCode = undefined
    get.mockResolvedValue({ content: '' })
    put.mockResolvedValue(undefined)
  })

  it('edits over the config route (server-host file, works remotely)', async () => {
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
    put.mockRejectedValue(new ServerError('VALIDATION', 'user Dockerfile must be layered'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await configEditUserDockerfile()

    expect(process.exitCode).toBe(1)
    const messages = errorSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => /must be layered/.test(m))).toBe(true)
    expect(messages.some((m) => m.startsWith('Your edits are kept at '))).toBe(true)
    errorSpy.mockRestore()
  })
})
