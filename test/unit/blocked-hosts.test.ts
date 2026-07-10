import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir } from '@/shared/project-paths'
import { blockedHostsStatePath, readBlockedHosts } from '@/lib/session/blocked-hosts'

describe('blocked-hosts', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-blocked-hosts-test-'))
    setDataDir(tmpDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function writeStateFile(content: string): Promise<void> {
    const file = blockedHostsStatePath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  }

  it('blockedHostsStatePath points into the proxy-data host dir', () => {
    expect(blockedHostsStatePath()).toBe(
      path.join(tmpDir, 'run', 'proxy-data', 'blocked-hosts.json'),
    )
  })

  it('readBlockedHosts returns empty array when no file exists', async () => {
    const hosts = await readBlockedHosts('nonexistent-session')
    expect(hosts).toEqual([])
  })

  it('readBlockedHosts reads the session entry from the proxy write-through file', async () => {
    await writeStateFile(JSON.stringify({
      'session-123': ['evil.com', 'bad.org'],
      'session-456': ['worse.net'],
    }))

    expect(await readBlockedHosts('session-123')).toEqual(['evil.com', 'bad.org'])
    expect(await readBlockedHosts('session-456')).toEqual(['worse.net'])
    expect(await readBlockedHosts('session-789')).toEqual([])
  })

  it('readBlockedHosts tolerates a torn or malformed file', async () => {
    await writeStateFile('{"session-123": ["evil.co')
    expect(await readBlockedHosts('session-123')).toEqual([])

    await writeStateFile('"not-an-object"')
    expect(await readBlockedHosts('session-123')).toEqual([])
  })

  it('readBlockedHosts drops non-string entries and non-array values', async () => {
    await writeStateFile(JSON.stringify({
      'session-123': ['evil.com', 42, null, 'bad.org'],
      'session-456': 'not-an-array',
    }))
    expect(await readBlockedHosts('session-123')).toEqual(['evil.com', 'bad.org'])
    expect(await readBlockedHosts('session-456')).toEqual([])
  })
})
