import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir } from '@yaac/shared/project-paths'
import { readAllGitAuthFailures, readGitAuthFailures } from '#features/projects'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-git-auth-failures-test-'))
  setDataDir(tmpDir)
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

/** Write the proxy's write-through file at its literal host path. Spelled out
 *  rather than derived, so a move of the proxy's /data hostPath fails here
 *  instead of silently reading a file nothing writes. */
async function writeStateFile(content: string): Promise<void> {
  const file = path.join(tmpDir, 'run', 'proxy-data', 'git-auth-failures.json')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

describe('readAllGitAuthFailures', () => {
  it('returns an empty map when the proxy has written no file', async () => {
    expect(await readAllGitAuthFailures()).toEqual({})
  })

  it('reads every project entry from the proxy write-through file', async () => {
    await writeStateFile(JSON.stringify({
      'project-a': [{ host: 'github.com', status: 401, atMs: 1751700000000 }],
      'project-b': [{ host: 'gitlab.acme.com', status: 403, atMs: 1751700001000 }],
    }))

    expect(await readAllGitAuthFailures()).toEqual({
      'project-a': [{ host: 'github.com', status: 401, atMs: 1751700000000 }],
      'project-b': [{ host: 'gitlab.acme.com', status: 403, atMs: 1751700001000 }],
    })
  })

  it('tolerates a torn or malformed file', async () => {
    await writeStateFile('{"project-a": [{"host": "github.co')
    expect(await readAllGitAuthFailures()).toEqual({})

    await writeStateFile('"not-an-object"')
    expect(await readAllGitAuthFailures()).toEqual({})
  })

  it('drops malformed entries, non-array values, and empty projects', async () => {
    await writeStateFile(JSON.stringify({
      'project-a': [
        { host: 'github.com', status: 401, atMs: 1751700000000 },
        { host: 42, status: 401, atMs: 1 },
        { host: 'no-status.com' },
        null,
        'not-an-object',
      ],
      'project-b': 'not-an-array',
      'project-c': [{ host: 13 }],
    }))
    expect(await readAllGitAuthFailures()).toEqual({
      'project-a': [{ host: 'github.com', status: 401, atMs: 1751700000000 }],
    })
  })
})

describe('readGitAuthFailures', () => {
  it('returns one project\'s entries and [] for projects with none', async () => {
    await writeStateFile(JSON.stringify({
      'project-a': [{ host: 'github.com', status: 401, atMs: 1751700000000 }],
      'project-b': 'not-an-array',
    }))

    expect(await readGitAuthFailures('project-a')).toEqual([
      { host: 'github.com', status: 401, atMs: 1751700000000 },
    ])
    expect(await readGitAuthFailures('project-b')).toEqual([])
    expect(await readGitAuthFailures('unknown')).toEqual([])
  })

  it('returns [] when the file is missing or torn', async () => {
    expect(await readGitAuthFailures('project-a')).toEqual([])
    await writeStateFile('{"project-a": [{"host": "github.co')
    expect(await readGitAuthFailures('project-a')).toEqual([])
  })
})
