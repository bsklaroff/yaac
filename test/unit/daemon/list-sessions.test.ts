import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'

vi.mock('@/lib/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listSessionPods: vi.fn().mockResolvedValue([]),
    listSessionJobs: vi.fn().mockResolvedValue([]),
  }
})

import { listSessionPods, type SessionPod } from '@/lib/k8s/pods'
import type * as podsModule from '@/lib/k8s/pods'
import * as cleanup from '@/lib/session/cleanup'
import * as opencodeStatus from '@/lib/session/opencode-status'
import {
  claudeDir,
  getProjectsDir,
  opencodeMetaDir,
  opencodeMetaFile,
  projectDir,
} from '@/lib/project/paths'
import {
  listActiveSessions,
  listDeletedSessions,
  captureOpencodeFirstMessages,
  _clearListActiveInflightForTests,
} from '@/lib/session/list'
import { DaemonError } from '@/daemon/errors'
import type { ProjectMeta } from '@/shared/types'

const mockListPods = vi.mocked(listSessionPods)

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
    _clearListActiveInflightForTests()
    mockListPods.mockReset()
    mockListPods.mockResolvedValue([])
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when the project filter points at an unknown slug', async () => {
    await expect(listActiveSessions('does-not-exist')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns empty arrays with no session pods', async () => {
    const result = await listActiveSessions()
    expect(result.sessions).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('throws RUNTIME_UNAVAILABLE when the pod listing fails', async () => {
    mockListPods.mockRejectedValueOnce(new Error('connection refused'))
    await expect(listActiveSessions()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  })
})

describe('listDeletedSessions', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    mockListPods.mockReset()
    mockListPods.mockResolvedValue([])
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

  it('enumerates Claude JSONL sessions that have no active pod', async () => {
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

  it('skips sessions that still have an active pod', async () => {
    await writeProject('demo')
    const sessionsDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(sessionsDir, { recursive: true })
    await fs.writeFile(path.join(sessionsDir, 'active1.jsonl'), '{}\n')
    mockListPods.mockResolvedValue([{
      jobName: 'yaac-demo-active1',
      podName: 'yaac-demo-active1-x1',
      sessionId: 'active1',
      projectSlug: 'demo',
      tool: 'claude',
      phase: 'Running',
      running: true,
      createdAtMs: 0,
      labels: {},
    }])
    const result = await listDeletedSessions('demo')
    expect(result).toEqual([])
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

  it('enumerates opencode sessions from the meta cache with no active pod', async () => {
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

  function pod(overrides: { sessionId: string; tool: string }): SessionPod {
    return {
      jobName: `yaac-demo-${overrides.sessionId}`,
      podName: `yaac-demo-${overrides.sessionId}-x1`,
      sessionId: overrides.sessionId,
      projectSlug: 'demo',
      tool: overrides.tool,
      phase: 'Running',
      running: true,
      createdAtMs: 0,
      labels: {},
    }
  }

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    mockListPods.mockReset()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanupTempDir(tmpDir)
  })

  it('captures only running opencode sessions, skipping other tools', async () => {
    mockListPods.mockResolvedValue([
      pod({ sessionId: 'ocsess', tool: 'opencode' }),
      pod({ sessionId: 'clsess', tool: 'claude' }),
    ])
    vi.spyOn(cleanup, 'isTmuxSessionAlive').mockResolvedValue(true)
    const captureSpy = vi
      .spyOn(opencodeStatus, 'ensureOpencodeFirstMessageCaptured')
      .mockResolvedValue(undefined)

    await captureOpencodeFirstMessages()

    expect(captureSpy).toHaveBeenCalledTimes(1)
    expect(captureSpy).toHaveBeenCalledWith('demo', 'ocsess', 'yaac-demo-ocsess')
  })

  it('returns early without capturing when the cluster is unavailable', async () => {
    mockListPods.mockRejectedValue(new Error('down'))
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
    _clearListActiveInflightForTests()
    mockListPods.mockReset()
    mockListPods.mockResolvedValue([])
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
