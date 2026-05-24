import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import * as runtime from '@/lib/container/runtime'
import * as cleanup from '@/lib/session/cleanup'
import * as opencodeStatus from '@/lib/session/opencode-status'
import {
  claudeDir,
  getDataDir,
  getProjectsDir,
  opencodeMetaDir,
  opencodeMetaFile,
  projectDir,
} from '@/lib/project/paths'
import {
  listActiveSessions,
  listDeletedSessions,
  captureOpencodeFirstMessages,
} from '@/lib/session/list'
import { DaemonError } from '@/daemon/errors'
import type { ProjectMeta } from '@/shared/types'

async function writeProject(slug: string, meta: Partial<ProjectMeta> = {}): Promise<void> {
  const full: ProjectMeta = {
    slug,
    remoteUrl: meta.remoteUrl ?? `https://example.com/${slug}`,
    addedAt: meta.addedAt ?? '2026-01-01T00:00:00.000Z',
  }
  const dir = path.join(getProjectsDir(), slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(full))
}

describe('listActiveSessions', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when the project filter points at an unknown slug', async () => {
    await expect(listActiveSessions('does-not-exist')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns empty arrays with no containers and no prewarm state', async () => {
    const result = await listActiveSessions()
    expect(result.sessions).toEqual([])
    expect(result.stale).toEqual([])
    expect(result.failedPrewarms).toEqual([])
  })

  it('surfaces failed prewarms from the state file', async () => {
    await writeProject('foo')
    const prewarmFile = path.join(tmpDir, '.prewarm-sessions.json')
    const entry = {
      sessionId: 'abc',
      containerName: 'yaac-foo-abc',
      fingerprint: 'fp-1',
      state: 'failed' as const,
      verifiedAt: 1_700_000_000_000,
    }
    await fs.writeFile(prewarmFile, JSON.stringify({ foo: entry }))
    const result = await listActiveSessions('foo')
    expect(result.failedPrewarms).toEqual([
      { slug: 'foo', fingerprint: 'fp-1', verifiedAt: 1_700_000_000_000 },
    ])
  })
})

describe('listDeletedSessions', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when the project filter points at an unknown slug', async () => {
    await expect(listDeletedSessions('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns [] when no projects exist', async () => {
    await fs.rm(getProjectsDir(), { recursive: true, force: true })
    const result = await listDeletedSessions()
    expect(result).toEqual([])
  })

  it('enumerates Claude JSONL sessions that have no active container', async () => {
    await writeProject('demo')
    const sessionsDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(sessionsDir, { recursive: true })
    await fs.writeFile(path.join(sessionsDir, 'aaaaaa.jsonl'), '{}\n')
    await fs.writeFile(path.join(sessionsDir, 'ignoreme.txt'), 'not jsonl')
    const result = await listDeletedSessions('demo')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      sessionId: 'aaaaaa',
      projectSlug: 'demo',
      tool: 'claude',
    })
  })

  it('sorts newest first', async () => {
    await writeProject('demo')
    const sessionsDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(sessionsDir, { recursive: true })
    const oldPath = path.join(sessionsDir, 'old.jsonl')
    const newPath = path.join(sessionsDir, 'new.jsonl')
    await fs.writeFile(oldPath, '{}\n')
    await fs.writeFile(newPath, '{}\n')
    // Backdate the first file so lstat.birthtime sorts it older.
    await fs.utimes(oldPath, new Date('2026-01-01'), new Date('2026-01-01'))
    const result = await listDeletedSessions('demo')
    expect(result.map((r) => r.sessionId)).toEqual(['new', 'old'])
  })

  it('caps results to the requested limit after sorting newest-first', async () => {
    await writeProject('demo')
    const sessionsDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(sessionsDir, { recursive: true })
    for (let i = 0; i < 5; i++) {
      const p = path.join(sessionsDir, `s${i}.jsonl`)
      await fs.writeFile(p, '{}\n')
      // On Linux fs.utimes does not affect birthtime, so rely on actual
      // creation order with a small gap to keep ms-level sort deterministic.
      await new Promise((r) => setTimeout(r, 5))
    }
    const result = await listDeletedSessions('demo', 2)
    expect(result.map((r) => r.sessionId)).toEqual(['s4', 's3'])
  })

  it('returns all entries when limit is 0 or undefined', async () => {
    await writeProject('demo')
    const sessionsDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(sessionsDir, { recursive: true })
    for (const id of ['a', 'b', 'c']) {
      await fs.writeFile(path.join(sessionsDir, `${id}.jsonl`), '{}\n')
    }
    const noLimit = await listDeletedSessions('demo')
    const zeroLimit = await listDeletedSessions('demo', 0)
    expect(noLimit).toHaveLength(3)
    expect(zeroLimit).toHaveLength(3)
  })

  it('enumerates opencode sessions from the meta cache with no active container', async () => {
    await writeProject('demo')
    await fs.mkdir(opencodeMetaDir('demo'), { recursive: true })
    await fs.writeFile(
      opencodeMetaFile('demo', 'ocsess'),
      JSON.stringify({ firstMessage: 'build a thing', capturedAt: '2026-05-01T00:00:00.000Z' }),
    )
    await fs.writeFile(path.join(opencodeMetaDir('demo'), 'ignoreme.txt'), 'not json')
    const result = await listDeletedSessions('demo')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      sessionId: 'ocsess',
      projectSlug: 'demo',
      tool: 'opencode',
      prompt: 'build a thing',
    })
  })

  it('populates prompt from the first user message in the Claude transcript', async () => {
    await writeProject('demo')
    const sessionsDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(sessionsDir, { recursive: true })
    const first = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello there' } })
    await fs.writeFile(path.join(sessionsDir, 'a.jsonl'), `${first}\n`)
    const result = await listDeletedSessions('demo')
    expect(result[0]?.prompt).toBe('hello there')
  })
})

describe('captureOpencodeFirstMessages', () => {
  let tmpDir: string

  function container(overrides: {
    id: string
    sessionId: string
    tool: string
  }): Record<string, unknown> {
    return {
      Id: overrides.id,
      Names: [`/yaac-demo-${overrides.sessionId}`],
      Labels: {
        'yaac.data-dir': getDataDir(),
        'yaac.session-id': overrides.sessionId,
        'yaac.project': 'demo',
        'yaac.tool': overrides.tool,
      },
      State: 'running',
    }
  }

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanupTempDir(tmpDir)
  })

  it('captures only running opencode sessions, skipping other tools', async () => {
    vi.spyOn(runtime.podman, 'listContainers').mockResolvedValue([
      container({ id: 'oc', sessionId: 'ocsess', tool: 'opencode' }),
      container({ id: 'cl', sessionId: 'clsess', tool: 'claude' }),
    ] as unknown as Awaited<ReturnType<typeof runtime.podman.listContainers>>)
    vi.spyOn(cleanup, 'isTmuxSessionAlive').mockResolvedValue(true)
    const captureSpy = vi
      .spyOn(opencodeStatus, 'ensureOpencodeFirstMessageCaptured')
      .mockResolvedValue(undefined)

    await captureOpencodeFirstMessages()

    expect(captureSpy).toHaveBeenCalledTimes(1)
    expect(captureSpy).toHaveBeenCalledWith('demo', 'ocsess', 'yaac-demo-ocsess')
  })

  it('returns early without capturing when podman is unavailable', async () => {
    vi.spyOn(runtime.podman, 'listContainers').mockRejectedValue(new Error('down'))
    const captureSpy = vi
      .spyOn(opencodeStatus, 'ensureOpencodeFirstMessageCaptured')
      .mockResolvedValue(undefined)

    await expect(captureOpencodeFirstMessages()).resolves.toBeUndefined()
    expect(captureSpy).not.toHaveBeenCalled()
  })
})

describe('listActiveSessions project filter', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('accepts the project filter when project.json exists', async () => {
    await fs.mkdir(projectDir('valid'), { recursive: true })
    await fs.writeFile(
      path.join(projectDir('valid'), 'project.json'),
      JSON.stringify({ slug: 'valid', remoteUrl: 'x', addedAt: 'y' }),
    )
    const result = await listActiveSessions('valid')
    expect(result.sessions).toEqual([])
  })

  it('raises DaemonError for unknown projects', async () => {
    await expect(listActiveSessions('bogus')).rejects.toBeInstanceOf(DaemonError)
  })
})
