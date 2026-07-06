import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir } from '@/lib/project/paths'
import { gitAuthFailuresStatePath, readGitAuthFailures } from '@/lib/session/git-auth-failures'

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

  it('readGitAuthFailures returns empty array when no file exists', async () => {
    expect(await readGitAuthFailures('nonexistent-session')).toEqual([])
  })

  it('readGitAuthFailures reads the session entry from the proxy write-through file', async () => {
    await writeStateFile(JSON.stringify({
      'session-123': [{ host: 'github.com', status: 401, atMs: 1751700000000 }],
      'session-456': [{ host: 'gitlab.acme.com', status: 403, atMs: 1751700001000 }],
    }))

    expect(await readGitAuthFailures('session-123')).toEqual([
      { host: 'github.com', status: 401, atMs: 1751700000000 },
    ])
    expect(await readGitAuthFailures('session-456')).toEqual([
      { host: 'gitlab.acme.com', status: 403, atMs: 1751700001000 },
    ])
    expect(await readGitAuthFailures('session-789')).toEqual([])
  })

  it('readGitAuthFailures tolerates a torn or malformed file', async () => {
    await writeStateFile('{"session-123": [{"host": "github.co')
    expect(await readGitAuthFailures('session-123')).toEqual([])

    await writeStateFile('"not-an-object"')
    expect(await readGitAuthFailures('session-123')).toEqual([])
  })

  it('readGitAuthFailures drops malformed entries and non-array values', async () => {
    await writeStateFile(JSON.stringify({
      'session-123': [
        { host: 'github.com', status: 401, atMs: 1751700000000 },
        { host: 42, status: 401, atMs: 1 },
        { host: 'no-status.com' },
        null,
        'not-an-object',
      ],
      'session-456': 'not-an-array',
    }))
    expect(await readGitAuthFailures('session-123')).toEqual([
      { host: 'github.com', status: 401, atMs: 1751700000000 },
    ])
    expect(await readGitAuthFailures('session-456')).toEqual([])
  })
})
