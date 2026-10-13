import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  configEditProject,
  configEditDockerfile,
  configEditUserDockerfile,
} from '#commands/config-edit'
import { startFakeApi, type FakeApi } from './fake-api'

/**
 * The config edit commands against a fake server and a stub $EDITOR, which
 * overwrites the scratch file with what the case puts in `EDIT_WITH`, or
 * leaves it alone when that is unset.
 */
let api: FakeApi
let scratch: string
let logged: string[]
let errors: string[]

beforeAll(async () => {
  api = await startFakeApi()
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-config-edit-'))
  const editor = path.join(scratch, 'editor.sh')
  await fs.writeFile(editor, '#!/bin/sh\n[ -n "$EDIT_WITH" ] && printf %s "$EDIT_WITH" > "$1"\nexit 0\n', { mode: 0o755 })
  vi.stubEnv('YAAC_SERVER_URL', api.url)
  vi.stubEnv('EDITOR', editor)
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await api.close()
  await fs.rm(scratch, { recursive: true, force: true })
})

beforeEach(() => {
  api.reset()
  logged = []
  errors = []
  vi.spyOn(console, 'log').mockImplementation((msg: unknown) => { logged.push(String(msg)) })
  vi.spyOn(console, 'error').mockImplementation((msg: unknown) => { errors.push(String(msg)) })
  vi.stubEnv('EDIT_WITH', '')
  process.exitCode = undefined
  // The project the user named resolves to its id once, up front.
  api.on('GET /api/project/demo', { json: { id: 'id-demo', name: 'demo' } })
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

const editorWrites = (text: string): void => { vi.stubEnv('EDIT_WITH', text) }
const sent = (route: string): unknown[] => api.requests.filter((r) => r.route === route).map((r) => r.body)

/** The scratch file a failed save kept, read back, then removed. */
async function keptEdits(): Promise<string> {
  const line = errors.find((m) => m.startsWith('Your edits are kept at '))
  expect(line).toBeDefined()
  const kept = line!.replace('Your edits are kept at ', '')
  const text = await fs.readFile(kept, 'utf8')
  await fs.rm(path.dirname(kept), { recursive: true, force: true })
  return text
}

describe('configEditProject', () => {
  const RAW = 'GET /api/project/id-demo/config/raw'
  const PUT = 'PUT /api/project/id-demo/config'
  const DELETE = 'DELETE /api/project/id-demo/config'

  beforeEach(() => {
    api.on(RAW, { json: { content: '{\n  "env": {}\n}\n' } })
    api.on(PUT, {})
    api.on(DELETE, {})
  })

  it('fetches the raw content, edits a scratch copy, and PUTs the parsed JSON', async () => {
    editorWrites('{ "env": { "FOO": "1" } }')
    await configEditProject('demo')
    expect(sent(PUT)).toEqual([{ config: { env: { FOO: '1' } } }])
    expect(logged).toContain('Saved project config.')
  })

  it('makes no write when the editor leaves the content unchanged', async () => {
    await configEditProject('demo')
    expect(sent(PUT)).toEqual([])
    expect(logged).toContain('No changes.')
  })

  it('an emptied buffer clears the config via DELETE', async () => {
    editorWrites('\n')
    await configEditProject('demo')
    expect(sent(DELETE)).toHaveLength(1)
    expect(sent(PUT)).toEqual([])
  })

  it('invalid JSON fails with exitCode 1 and keeps the scratch file', async () => {
    editorWrites('{ not json')
    await configEditProject('demo')
    expect(process.exitCode).toBe(1)
    expect(sent(PUT)).toEqual([])
    expect(errors.some((m) => /Invalid JSON/.test(m))).toBe(true)
    expect(await keptEdits()).toBe('{ not json')
  })

  it('a server validation failure keeps the scratch file too', async () => {
    editorWrites('{ "nestedContainers": "yes" }')
    api.on(PUT, { status: 400, json: { error: { code: 'VALIDATION', message: 'nestedContainers must be a boolean' } } })
    await configEditProject('demo')
    expect(process.exitCode).toBe(1)
    expect(errors.some((m) => /nestedContainers must be a boolean/.test(m))).toBe(true)
    expect(await keptEdits()).toBe('{ "nestedContainers": "yes" }')
  })

  it('propagates a NOT_FOUND before opening the editor', async () => {
    await expect(configEditProject('nope')).rejects.toThrow('no route GET /api/project/nope')
    expect(sent(RAW)).toEqual([])
  })
})

describe('configEditDockerfile', () => {
  it('round-trips the edited content verbatim', async () => {
    api.on('GET /api/project/id-demo/dockerfile', { json: { content: '' } })
    api.on('PUT /api/project/id-demo/dockerfile', {})
    editorWrites('RUN true\n')
    await configEditDockerfile('demo')
    expect(sent('PUT /api/project/id-demo/dockerfile')).toEqual([{ content: 'RUN true\n' }])
    expect(logged).toContainEqual(expect.stringMatching(/next workspace created/))
  })
})

describe('configEditUserDockerfile', () => {
  const PUT = 'PUT /api/config/user-dockerfile'

  beforeEach(() => {
    api.on('GET /api/config/user-dockerfile', { json: { content: '' } })
  })

  it('edits over the config route (server-host file, works remotely)', async () => {
    api.on(PUT, {})
    editorWrites('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN true\n')
    await configEditUserDockerfile()
    expect(sent(PUT)).toEqual([{ content: 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN true\n' }])
    expect(logged).toContain('Saved the user Dockerfile.')
  })

  it('a rejected (non-layered) Dockerfile keeps the scratch file', async () => {
    api.on(PUT, { status: 400, json: { error: { code: 'VALIDATION', message: 'user Dockerfile must be layered' } } })
    editorWrites('FROM scratch\n')
    await configEditUserDockerfile()
    expect(process.exitCode).toBe(1)
    expect(errors.some((m) => /must be layered/.test(m))).toBe(true)
    expect(await keptEdits()).toBe('FROM scratch\n')
  })
})
