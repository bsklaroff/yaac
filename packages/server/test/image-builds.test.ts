import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  attachImageBuildProject,
  clearAllImageBuildsForTests,
  dismissImageBuild,
  failImageBuild,
  finishImageBuild,
  forgetImageBuild,
  getImageBuild,
  getImageBuildLog,
  hasBlockingFailure,
  ingestImageBuildLine,
  listImageBuilds,
  parseBuildStep,
  registerImageBuild,
} from '#image-builds'
import { onSessionListChanged, _resetSessionListChangedForTests } from '#sessions-changed'

function register(overrides: Partial<Parameters<typeof registerImageBuild>[0]> = {}): string {
  return registerImageBuild({
    tag: 'yaac-base:abc123',
    layer: 'base',
    action: 'build',
    projectSlug: 'proj-a',
    reason: 'prewarm',
    ...overrides,
  })
}

describe('image-builds registry', () => {
  beforeEach(() => { clearAllImageBuildsForTests() })
  afterEach(() => {
    clearAllImageBuildsForTests()
    _resetSessionListChangedForTests()
    vi.useRealTimers()
  })

  describe('registerImageBuild / listImageBuilds', () => {
    it('projects a running entry with a formatted start time', () => {
      const id = register()
      const [entry] = listImageBuilds()
      expect(entry.id).toBe(id)
      expect(entry.tag).toBe('yaac-base:abc123')
      expect(entry.layer).toBe('base')
      expect(entry.action).toBe('build')
      expect(entry.projectSlugs).toEqual(['proj-a'])
      expect(entry.reason).toBe('prewarm')
      expect(entry.status).toBe('running')
      expect(entry.startedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      expect(entry.finishedAt).toBeUndefined()
    })

    it('lists newest first', () => {
      vi.useFakeTimers()
      register({ tag: 'a:1' })
      vi.advanceTimersByTime(1000)
      register({ tag: 'b:2' })
      expect(listImageBuilds().map((e) => e.tag)).toEqual(['b:2', 'a:1'])
    })

    it('supersedes a finished entry for the same tag+action', () => {
      const first = register()
      failImageBuild(first, 'boom')
      const second = register()
      const entries = listImageBuilds()
      expect(entries.map((e) => e.id)).toEqual([second])
      expect(entries[0].status).toBe('running')
    })

    it('keeps a running entry for the same tag alongside a new one', () => {
      // The coordinator single-flights per tag, so this shouldn't happen for
      // builds — but a push and a build of one tag may legitimately coexist.
      register({ action: 'build' })
      register({ action: 'push', layer: 'push' })
      expect(listImageBuilds()).toHaveLength(2)
    })

    it('registers an infra build with no owning project (empty projectSlugs)', () => {
      registerImageBuild({ tag: 'yaac-proxy:xyz', layer: 'proxy', action: 'build', reason: 'session' })
      const [entry] = listImageBuilds()
      expect(entry.layer).toBe('proxy')
      expect(entry.projectSlugs).toEqual([])
    })
  })

  describe('getImageBuild', () => {
    it('projects a single entry and returns undefined for an unknown id', () => {
      const id = register()
      expect(getImageBuild(id)?.tag).toBe('yaac-base:abc123')
      expect(getImageBuild('missing')).toBeUndefined()
    })

    it('still returns a dismissed entry (so retry can read its target)', () => {
      const id = register()
      failImageBuild(id, 'boom')
      dismissImageBuild(id)
      expect(listImageBuilds()).toEqual([])
      expect(getImageBuild(id)?.projectSlugs).toEqual(['proj-a'])
    })
  })

  describe('attachImageBuildProject', () => {
    it('adds a joiner project once', () => {
      const id = register()
      attachImageBuildProject(id, 'proj-b')
      attachImageBuildProject(id, 'proj-b')
      expect(listImageBuilds()[0].projectSlugs).toEqual(['proj-a', 'proj-b'])
    })

    it('notifies only on a real change', () => {
      const id = register()
      const notify = vi.fn()
      onSessionListChanged(notify)
      attachImageBuildProject(id, 'proj-b')
      expect(notify).toHaveBeenCalledTimes(1)
      attachImageBuildProject(id, 'proj-b')
      attachImageBuildProject('missing-id', 'proj-c')
      expect(notify).toHaveBeenCalledTimes(1)
    })
  })

  describe('ingestImageBuildLine', () => {
    it('accumulates the log and strips ANSI escapes', () => {
      const id = register()
      ingestImageBuildLine(id, '\x1b[1mSTEP 1/3\x1b[0m: FROM ubuntu')
      ingestImageBuildLine(id, 'plain line')
      expect(getImageBuildLog(id)).toBe('STEP 1/3: FROM ubuntu\nplain line\n')
    })

    it('caps the log tail', () => {
      const id = register()
      const line = 'x'.repeat(10_000)
      for (let i = 0; i < 10; i++) ingestImageBuildLine(id, line)
      const log = getImageBuildLog(id)!
      expect(log.length).toBeLessThanOrEqual(64_000)
      expect(log.endsWith(`${line}\n`)).toBe(true)
    })

    it('updates step progress and notifies only when the step changes', () => {
      const id = register()
      const notify = vi.fn()
      onSessionListChanged(notify)

      ingestImageBuildLine(id, 'random output')
      expect(notify).not.toHaveBeenCalled()

      ingestImageBuildLine(id, 'STEP 2/5: RUN apt-get update')
      expect(notify).toHaveBeenCalledTimes(1)
      const [entry] = listImageBuilds()
      expect(entry.stepCurrent).toBe(2)
      expect(entry.stepTotal).toBe(5)
      expect(entry.stepText).toBe('RUN apt-get update')

      // Same step repeated → no extra broadcast.
      ingestImageBuildLine(id, 'STEP 2/5: RUN apt-get update')
      expect(notify).toHaveBeenCalledTimes(1)
    })

    it('ignores lines for unknown ids', () => {
      expect(() => ingestImageBuildLine('nope', 'line')).not.toThrow()
    })
  })

  describe('parseBuildStep', () => {
    it('parses podman STEP lines', () => {
      expect(parseBuildStep('STEP 3/14: RUN apt-get update')).toEqual({
        current: 3, total: 14, text: 'RUN apt-get update',
      })
    })

    it('returns null for anything else', () => {
      expect(parseBuildStep('--> a1b2c3')).toBeNull()
      expect(parseBuildStep('COMMIT yaac-base:abc')).toBeNull()
      expect(parseBuildStep('almost STEP 1/2: nope')).toBeNull()
    })

    it('truncates long step text', () => {
      const parsed = parseBuildStep(`STEP 1/1: RUN ${'x'.repeat(500)}`)
      expect(parsed!.text.length).toBeLessThanOrEqual(120)
    })
  })

  describe('finish / fail / dismiss', () => {
    it('finishImageBuild marks succeeded with a finish time', () => {
      const id = register()
      finishImageBuild(id)
      const [entry] = listImageBuilds()
      expect(entry.status).toBe('succeeded')
      expect(entry.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    })

    it('failImageBuild records the error', () => {
      const id = register()
      failImageBuild(id, 'podman build exited with code 1')
      const [entry] = listImageBuilds()
      expect(entry.status).toBe('failed')
      expect(entry.error).toBe('podman build exited with code 1')
    })

    it('dismissImageBuild hides a finished row (once) but never a running one', () => {
      const running = register({ tag: 'a:1' })
      const failed = register({ tag: 'b:2' })
      failImageBuild(failed, 'boom')

      expect(dismissImageBuild(running)).toBe(false)
      expect(dismissImageBuild(failed)).toBe(true)
      expect(dismissImageBuild(failed)).toBe(false) // already dismissed
      expect(listImageBuilds().map((e) => e.id)).toEqual([running])
    })

    it('forgetImageBuild removes a finished entry entirely but never a running one', () => {
      const running = register({ tag: 'a:1' })
      const failed = register({ tag: 'b:2' })
      failImageBuild(failed, 'boom')

      expect(forgetImageBuild(running)).toBe(false)
      expect(forgetImageBuild(failed)).toBe(true)
      expect(forgetImageBuild(failed)).toBe(false) // gone
      expect(getImageBuild(failed)).toBeUndefined()
      expect(listImageBuilds().map((e) => e.id)).toEqual([running])
    })
  })

  describe('retention and caps', () => {
    it('keeps finished entries indefinitely — nothing ages out on a timer', () => {
      vi.useFakeTimers()
      const ok = register({ tag: 'ok:1' })
      const bad = register({ tag: 'bad:2' })
      finishImageBuild(ok)
      failImageBuild(bad, 'boom')

      vi.advanceTimersByTime(60 * 60_000) // an hour later
      expect(listImageBuilds().map((e) => e.tag).sort()).toEqual(['bad:2', 'ok:1'])
    })

    it('caps total entries, dropping oldest finished first and never running', () => {
      vi.useFakeTimers()
      const runningIds: string[] = []
      for (let i = 0; i < 32; i++) {
        const id = register({ tag: `t:${i}` })
        if (i < 2) runningIds.push(id)
        else failImageBuild(id, 'x')
        vi.advanceTimersByTime(10)
      }
      const entries = listImageBuilds()
      expect(entries.length).toBeLessThanOrEqual(30)
      for (const id of runningIds) {
        expect(entries.some((e) => e.id === id)).toBe(true)
      }
    })
  })

  describe('hasBlockingFailure', () => {
    it('reports a recent failure matching one of the tags', () => {
      const id = register({ tag: 'yaac-tools:def' })
      failImageBuild(id, 'boom')
      expect(hasBlockingFailure(['yaac-base:abc', 'yaac-tools:def'], 10 * 60_000)).toBe(true)
    })

    it('ignores old failures, other tags, and non-failures', () => {
      vi.useFakeTimers()
      const stale = register({ tag: 'stale:1' })
      failImageBuild(stale, 'boom')
      const ok = register({ tag: 'ok:2' })
      finishImageBuild(ok)

      vi.advanceTimersByTime(11 * 60_000)
      expect(hasBlockingFailure(['stale:1'], 10 * 60_000)).toBe(false)
      expect(hasBlockingFailure(['ok:2'], 10 * 60_000)).toBe(false)
      expect(hasBlockingFailure(['other:3'], 10 * 60_000)).toBe(false)
    })

    it('still blocks after a dismiss (dismiss only hides the row)', () => {
      const id = register({ tag: 'yaac-base:abc' })
      failImageBuild(id, 'boom')
      dismissImageBuild(id)
      expect(hasBlockingFailure(['yaac-base:abc'], 10 * 60_000)).toBe(true)
    })

    it('clears when the failure is forgotten (the retry path)', () => {
      const id = register({ tag: 'yaac-base:abc' })
      failImageBuild(id, 'boom')
      forgetImageBuild(id)
      expect(hasBlockingFailure(['yaac-base:abc'], 10 * 60_000)).toBe(false)
    })
  })
})
