import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir } from '@/lib/project/paths'
import { readBlockedHosts, readAllBlockedHosts } from '@/lib/session/blocked-hosts'

describe('blocked-hosts', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-blocked-hosts-test-'))
    setDataDir(tmpDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('readBlockedHosts returns empty array when no file exists', async () => {
    const hosts = await readBlockedHosts('my-project', 'nonexistent-session')
    expect(hosts).toEqual([])
  })

  it('readBlockedHosts reads persisted file', async () => {
    const dir = path.join(tmpDir, 'projects', 'my-project', 'blocked-hosts')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'session-123.json'), JSON.stringify(['evil.com', 'bad.org']))

    const hosts = await readBlockedHosts('my-project', 'session-123')
    expect(hosts).toEqual(['evil.com', 'bad.org'])
  })

  it('readAllBlockedHosts aggregates from multiple sessions', async () => {
    const dir1 = path.join(tmpDir, 'projects', 'proj-a', 'blocked-hosts')
    const dir2 = path.join(tmpDir, 'projects', 'proj-b', 'blocked-hosts')
    await fs.mkdir(dir1, { recursive: true })
    await fs.mkdir(dir2, { recursive: true })
    await fs.writeFile(path.join(dir1, 'sess-1.json'), JSON.stringify(['evil.com']))
    await fs.writeFile(path.join(dir2, 'sess-2.json'), JSON.stringify(['bad.org', 'worse.net']))

    const result = await readAllBlockedHosts([
      { sessionId: 'sess-1', projectSlug: 'proj-a' },
      { sessionId: 'sess-2', projectSlug: 'proj-b' },
      { sessionId: 'sess-3', projectSlug: 'proj-a' }, // no file
    ])

    expect(result['sess-1']).toEqual(['evil.com'])
    expect(result['sess-2']).toEqual(['bad.org', 'worse.net'])
    expect(result['sess-3']).toBeUndefined()
  })
})
