import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  anySessionDirsExist,
  armDeferredClusterBoot,
  awaitDeferredClusterBoot,
  isDeferredClusterBootPending,
  triggerDeferredClusterBoot,
} from '#platform/k8s'
// Internal, for the latch reset between cases.
import { _resetDeferredClusterBootForTests } from '#platform/k8s/deferred-boot'

beforeEach(() => {
  _resetDeferredClusterBootForTests()
})

describe('awaitDeferredClusterBoot', () => {
  it('resolves immediately when nothing is armed (the outer-server no-op)', async () => {
    await expect(awaitDeferredClusterBoot()).resolves.toBeUndefined()
    triggerDeferredClusterBoot() // must not throw either
  })

  it('swallows (but completes on) a failing boot, like the eager best-effort path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      armDeferredClusterBoot(() => Promise.reject(new Error('registry down')))
      await expect(awaitDeferredClusterBoot()).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('registry down'))
    } finally {
      warn.mockRestore()
    }
  })
})

describe('armDeferredClusterBoot', () => {
  it('runs the armed boot exactly once across await + trigger', async () => {
    const boot = vi.fn().mockResolvedValue(undefined)
    armDeferredClusterBoot(boot)
    expect(boot).not.toHaveBeenCalled()

    triggerDeferredClusterBoot()
    await awaitDeferredClusterBoot()
    await awaitDeferredClusterBoot()
    expect(boot).toHaveBeenCalledTimes(1)
  })

  it('parks concurrent awaiters on the same in-flight run', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const boot = vi.fn().mockImplementation(() => gate)
    armDeferredClusterBoot(boot)

    let done = 0
    const a = awaitDeferredClusterBoot().then(() => { done += 1 })
    const b = awaitDeferredClusterBoot().then(() => { done += 1 })
    await new Promise((r) => setImmediate(r))
    expect(done).toBe(0)
    release()
    await Promise.all([a, b])
    expect(done).toBe(2)
    expect(boot).toHaveBeenCalledTimes(1)
  })
})

describe('triggerDeferredClusterBoot', () => {
  it('lets the boot closure\'s own kubectl-style triggers re-enter safely', async () => {
    // The armed closure's first cluster call goes through the kubectl
    // choke point, which fires the trigger again mid-boot — that must
    // not recurse into a second run.
    const boot = vi.fn().mockImplementation(async () => {
      triggerDeferredClusterBoot()
      await Promise.resolve()
    })
    armDeferredClusterBoot(boot)
    await awaitDeferredClusterBoot()
    expect(boot).toHaveBeenCalledTimes(1)
  })
})

describe('isDeferredClusterBootPending', () => {
  it('reports pending from arm until the boot settles, never on the outer server', async () => {
    expect(isDeferredClusterBootPending()).toBe(false)

    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    armDeferredClusterBoot(() => gate)
    expect(isDeferredClusterBootPending()).toBe(true)

    const run = awaitDeferredClusterBoot()
    expect(isDeferredClusterBootPending()).toBe(true)
    release()
    await run
    expect(isDeferredClusterBootPending()).toBe(false)
  })

  it('stops reporting pending after a failed boot too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      armDeferredClusterBoot(() => Promise.reject(new Error('registry down')))
      await awaitDeferredClusterBoot()
      expect(isDeferredClusterBootPending()).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('anySessionDirsExist', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-deferred-boot-'))
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('is false for a missing or empty projects dir', async () => {
    await expect(anySessionDirsExist(path.join(tmp, 'nope'))).resolves.toBe(false)
    await expect(anySessionDirsExist(tmp)).resolves.toBe(false)
  })

  it('is false for projects with no session dirs', async () => {
    await fs.mkdir(path.join(tmp, 'proj-a', 'sessions'), { recursive: true })
    await fs.mkdir(path.join(tmp, 'proj-b', 'repo'), { recursive: true })
    await expect(anySessionDirsExist(tmp)).resolves.toBe(false)
  })

  it('is true once any project has a session dir', async () => {
    await fs.mkdir(path.join(tmp, 'proj-a', 'sessions'), { recursive: true })
    await fs.mkdir(path.join(tmp, 'proj-b', 'sessions', 'sid-1'), { recursive: true })
    await expect(anySessionDirsExist(tmp)).resolves.toBe(true)
  })
})
