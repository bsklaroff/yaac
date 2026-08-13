import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  // clearAllImageBuildsForTests is the module's state-reset hook, not a
  // function under test — the seven entry points below are.
  clearAllImageBuildsForTests,
  dismissImageBuild,
  failImageBuild,
  finishImageBuild,
  getImageBuildLog,
  ingestImageBuildLine,
  listImageBuilds,
  registerImageBuild,
} from '#drivers/k8s/image-engine/image-builds'
import type * as notifyModule from '#notify'

vi.mock('#notify', async (importOriginal) => ({
  ...(await importOriginal<typeof notifyModule>()),
  notifyWorktreeListChanged: vi.fn(),
}))
import { notifyWorktreeListChanged } from '#notify'

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

beforeEach(() => { clearAllImageBuildsForTests() })
afterEach(() => {
  clearAllImageBuildsForTests()
  vi.useRealTimers()
})

describe('registerImageBuild', () => {
  it('tracks a running entry with its full descriptor', () => {
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

describe('listImageBuilds', () => {
  it('lists newest first', () => {
    vi.useFakeTimers()
    register({ tag: 'a:1' })
    vi.advanceTimersByTime(1000)
    register({ tag: 'b:2' })
    expect(listImageBuilds().map((e) => e.tag)).toEqual(['b:2', 'a:1'])
  })

  it('keeps finished entries indefinitely — nothing ages out on a timer', () => {
    vi.useFakeTimers()
    const ok = register({ tag: 'ok:1' })
    const bad = register({ tag: 'bad:2' })
    finishImageBuild(ok)
    failImageBuild(bad, 'boom')

    vi.advanceTimersByTime(60 * 60_000) // an hour later
    expect(listImageBuilds().map((e) => e.tag).sort()).toEqual(['bad:2', 'ok:1'])
  })

  it('caps total entries, dropping dismissed and oldest finished first and never running', () => {
    vi.useFakeTimers()
    const runningIds: string[] = []
    for (let i = 0; i < 32; i++) {
      const id = register({ tag: `t:${i}` })
      if (i < 2) runningIds.push(id)
      else {
        failImageBuild(id, 'x')
        // A couple of dismissed rows so the cap drops those before the
        // still-visible finished ones.
        if (i % 8 === 0) dismissImageBuild(id)
      }
      vi.advanceTimersByTime(10)
    }
    const entries = listImageBuilds()
    expect(entries.length).toBeLessThanOrEqual(30)
    for (const id of runningIds) {
      expect(entries.some((e) => e.id === id)).toBe(true)
    }
  })
})

describe('ingestImageBuildLine', () => {
  it('accumulates the log, strips ANSI escapes, and caps the tail', () => {
    const id = register()
    ingestImageBuildLine(id, '\x1b[1mSTEP 1/3\x1b[0m: FROM ubuntu')
    ingestImageBuildLine(id, 'plain line')
    expect(getImageBuildLog(id)).toBe('STEP 1/3: FROM ubuntu\nplain line\n')

    const long = 'x'.repeat(10_000)
    for (let i = 0; i < 10; i++) ingestImageBuildLine(id, long)
    const log = getImageBuildLog(id)!
    expect(log.length).toBeLessThanOrEqual(64_000)
    expect(log.endsWith(`${long}\n`)).toBe(true)
  })

  it('publishes podman STEP progress, broadcasting only when it advances', () => {
    const id = register()
    const notify = vi.mocked(notifyWorktreeListChanged)
    notify.mockClear()

    // Lines that aren't STEP progress leave the entry's step untouched —
    // including near-misses, so a changed podman format degrades to
    // status + raw log rather than reporting nonsense.
    for (const line of ['random output', '--> a1b2c3', 'COMMIT yaac-base:abc', 'almost STEP 1/2: nope']) {
      ingestImageBuildLine(id, line)
    }
    expect(notify).not.toHaveBeenCalled()
    expect(listImageBuilds()[0].stepCurrent).toBeUndefined()

    ingestImageBuildLine(id, 'STEP 2/5: RUN apt-get update')
    expect(notify).toHaveBeenCalledTimes(1)
    const [entry] = listImageBuilds()
    expect(entry.stepCurrent).toBe(2)
    expect(entry.stepTotal).toBe(5)
    expect(entry.stepText).toBe('RUN apt-get update')

    // Same step repeated → no extra broadcast.
    ingestImageBuildLine(id, 'STEP 2/5: RUN apt-get update')
    expect(notify).toHaveBeenCalledTimes(1)

    // A pathological instruction is truncated rather than held in full.
    ingestImageBuildLine(id, `STEP 3/5: RUN ${'x'.repeat(500)}`)
    expect(listImageBuilds()[0].stepText!.length).toBeLessThanOrEqual(120)
  })

  it('ignores lines for unknown ids', () => {
    expect(() => ingestImageBuildLine('nope', 'line')).not.toThrow()
  })
})

describe('finishImageBuild', () => {
  it('marks succeeded with a finish time', () => {
    const id = register()
    finishImageBuild(id)
    const [entry] = listImageBuilds()
    expect(entry.status).toBe('succeeded')
    expect(entry.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('is a no-op for an unknown id', () => {
    finishImageBuild('missing')
    expect(listImageBuilds()).toEqual([])
  })
})

describe('failImageBuild', () => {
  it('records the error against the entry', () => {
    const id = register()
    failImageBuild(id, 'podman build exited with code 1')
    const [entry] = listImageBuilds()
    expect(entry.status).toBe('failed')
    expect(entry.error).toBe('podman build exited with code 1')
  })

  it('is a no-op for an unknown id', () => {
    failImageBuild('missing', 'boom')
    expect(listImageBuilds()).toEqual([])
  })
})

describe('dismissImageBuild', () => {
  it('hides a finished row (once) but never a running one', () => {
    const running = register({ tag: 'a:1' })
    const failed = register({ tag: 'b:2' })
    failImageBuild(failed, 'boom')

    expect(dismissImageBuild(running)).toBe(false)
    expect(dismissImageBuild(failed)).toBe(true)
    expect(dismissImageBuild(failed)).toBe(false) // already dismissed
    expect(listImageBuilds().map((e) => e.id)).toEqual([running])
  })

  it('is a no-op for an unknown id', () => {
    expect(dismissImageBuild('missing')).toBe(false)
  })
})

describe('getImageBuildLog', () => {
  it('returns the accumulated tail, or undefined for an unknown id', () => {
    const id = register()
    expect(getImageBuildLog(id)).toBe('')
    ingestImageBuildLine(id, 'STEP 1/1: FROM ubuntu')
    expect(getImageBuildLog(id)).toBe('STEP 1/1: FROM ubuntu\n')
    expect(getImageBuildLog('missing')).toBeUndefined()
  })
})
