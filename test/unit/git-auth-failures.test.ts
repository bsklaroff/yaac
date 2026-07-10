import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir } from '@yaac/shared/project-paths'
import {
  gitAuthFailuresStatePath,
  readAllGitAuthFailures,
  readGitAuthFailures,
} from '@yaac/server/lib/project/git-auth-failures'

describe('git-auth-failures', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-git-auth-failures-test-'))
    setDataDir(tmpDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function writeStateFile(content: string): Promise<void> {
    const file = gitAuthFailuresStatePath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  }

  it('gitAuthFailuresStatePath points into the proxy-data host dir', () => {
    expect(gitAuthFailuresStatePath()).toBe(
      path.join(tmpDir, 'run', 'proxy-data', 'git-auth-failures.json'),
    )
  })

  it('readAllGitAuthFailures returns an empty map when no file exists', async () => {
    expect(await readAllGitAuthFailures()).toEqual({})
  })

  it('readAllGitAuthFailures reads every project entry from the proxy write-through file', async () => {
    await writeStateFile(JSON.stringify({
      'project-a': [{ host: 'github.com', status: 401, atMs: 1751700000000 }],
      'project-b': [{ host: 'gitlab.acme.com', status: 403, atMs: 1751700001000 }],
    }))

    expect(await readAllGitAuthFailures()).toEqual({
      'project-a': [{ host: 'github.com', status: 401, atMs: 1751700000000 }],
      'project-b': [{ host: 'gitlab.acme.com', status: 403, atMs: 1751700001000 }],
    })
  })

  it('readGitAuthFailures returns one project\'s entries and [] for unknown projects', async () => {
    await writeStateFile(JSON.stringify({
      'project-a': [{ host: 'github.com', status: 401, atMs: 1751700000000 }],
    }))

    expect(await readGitAuthFailures('project-a')).toEqual([
      { host: 'github.com', status: 401, atMs: 1751700000000 },
    ])
    expect(await readGitAuthFailures('project-b')).toEqual([])
  })

  it('tolerates a torn or malformed file', async () => {
    await writeStateFile('{"project-a": [{"host": "github.co')
    expect(await readAllGitAuthFailures()).toEqual({})
    expect(await readGitAuthFailures('project-a')).toEqual([])

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
    expect(await readGitAuthFailures('project-b')).toEqual([])
  })
})
