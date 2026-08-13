import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  failedCreateCollectsCheckout,
  launchPermissionMode,
  resolvePermissionMode,
  withUpstreamConfigLock,
} from '#domain/worktrees/create'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import {
  getProjectLastPermissionMode,
  recordProject,
  recordProjectPermissionMode,
} from '#db/project-store'

// The rule a failed create's rollback consults before removing a checkout.
// Both exclusions are here because getting either backwards destroys work
// that exists in no other copy — a resumed worktree's diff, or a spare's
// checkout pulled out from under the sweep that is about to collect it.
describe('failedCreateCollectsCheckout', () => {
  it('collects a fresh create’s own checkout', () => {
    expect(failedCreateCollectsCheckout({})).toBe(true)
    expect(failedCreateCollectsCheckout({ resume: false, prewarm: false })).toBe(true)
  })

  it('never collects a resumed worktree’s checkout — that is the work the user came back for', () => {
    expect(failedCreateCollectsCheckout({ resume: true })).toBe(false)
  })

  it('leaves a warmed spare to the sweep that collects it on its flag', () => {
    expect(failedCreateCollectsCheckout({ prewarm: true })).toBe(false)
  })
})

describe('withUpstreamConfigLock', () => {
  it('serializes tasks on one project', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>((r) => { releaseFirst = r })

    const first = withUpstreamConfigLock('p', async () => {
      order.push('first-start')
      await gate
      order.push('first-end')
    })
    const second = withUpstreamConfigLock('p', () => {
      order.push('second')
      return Promise.resolve()
    })

    // Give the second task a chance to (incorrectly) run early.
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['first-start'])

    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  it('runs different projects concurrently', async () => {
    const order: string[] = []
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => { releaseA = r })

    const a = withUpstreamConfigLock('a', async () => { await gateA; order.push('a') })
    const b = withUpstreamConfigLock('b', () => { order.push('b'); return Promise.resolve() })

    await b
    expect(order).toEqual(['b']) // b did not wait on a
    releaseA()
    await a
  })

  it('a failed predecessor does not poison the queue', async () => {
    const failing = withUpstreamConfigLock('p', () => Promise.reject(new Error('boom')))
    const task = vi.fn(() => Promise.resolve())
    const ok = withUpstreamConfigLock('p', task)

    await expect(failing).rejects.toThrow('boom')
    await expect(ok).resolves.toBeUndefined()
    expect(task).toHaveBeenCalledTimes(1)
  })
})

/**
 * What a create launches in, absent the project memory rung — the answer
 * every caller reaching createWorktree directly gets, and where the refusals
 * live. Sync and substrate-free: the driver is a parameter, which is what
 * lets the spawn policy default a posture without a driver registered.
 */
describe('launchPermissionMode', () => {
  const launch = (args: Partial<Parameters<typeof launchPermissionMode>[0]> = {}) =>
    launchPermissionMode({ tool: 'claude', mode: 'tui', driver: 'k8s', ...args })

  it('falls back to the driver default when nothing was asked for', () => {
    // Sandboxed: the container is the containment, so prompting inside it
    // protects nothing. Containerless acts as the user on the user's own
    // machine, so edits land freely but shells and out-of-tree writes ask.
    expect(launch()).toBe('bypass')
    expect(launch({ driver: 'containerless' })).toBe('accept-edits')
    // pi has no permission system anywhere, so bypass is the only truthful
    // answer even where the default would otherwise be accept-edits.
    expect(launch({ driver: 'containerless', tool: 'pi' })).toBe('bypass')
  })

  it('refuses a posture the tool does not have, naming the ones it does', () => {
    expect(() => launch({ tool: 'pi', requested: 'plan' }))
      .toThrow(/pi has no "plan" permission mode; it supports: bypass/)
    // opencode has no reviewer-model posture, but has the other four.
    expect(() => launch({ tool: 'opencode', requested: 'auto' })).toThrow(/no "auto"/)
    expect(launch({ tool: 'opencode', requested: 'plan' })).toBe('plan')
  })

  it('refuses any posture but bypass under acp, where prompts are auto-answered', () => {
    expect(() => launch({ mode: 'acp', requested: 'plan' })).toThrow(/bypass" permissions only/)
    expect(launch({ mode: 'acp', requested: 'bypass' })).toBe('bypass')
    expect(launch({ mode: 'acp' })).toBe('bypass')
  })

  // A restart re-states the row's posture rather than a person's. Refusing
  // one written by a different build would strand a checkout, and stranding
  // work is worse than launching at this tool's default.
  it('treats a resumed posture as a preference, not a demand', () => {
    expect(launch({ resume: true, tool: 'pi', requested: 'plan' })).toBe('bypass')
    expect(launch({ resume: true, requested: 'manual' })).toBe('manual')
  })

  // A row can predate the bypass-only rule — an older build recorded an ACP
  // worktree's posture without enforcing it, and the migration carries that
  // forward. Passing it through would leave the restarted row durably
  // claiming a restraint whose prompts are auto-answered, so the resume
  // normalizes rather than merely tolerating it.
  it('coerces a resumed acp posture to bypass, not just an unsupported one', () => {
    expect(launch({ resume: true, mode: 'acp', requested: 'manual' })).toBe('bypass')
    expect(launch({ resume: true, mode: 'acp', requested: 'plan' })).toBe('bypass')
  })
})

/**
 * The route-facing wrapper, which adds the project-memory rung. The db is
 * real (an empty temp data dir), because that rung IS the recorded row and a
 * mocked read would assert the mock rather than the precedence.
 */
describe('resolvePermissionMode', () => {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    await recordProject({ slug: 'p', remoteUrl: 'git@h:o/r.git', addedAt: 'now' })
  })
  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const resolve = (args: Partial<Parameters<typeof resolvePermissionMode>[0]> = {}) =>
    resolvePermissionMode({
      projectSlug: 'p', tool: 'claude', mode: 'tui', driver: 'k8s', ...args,
    })

  it('prefers what the project last had chosen over the driver default', async () => {
    expect(await resolve()).toBe('bypass')
    await recordProjectPermissionMode('p', 'plan')
    expect(await resolve()).toBe('plan')
    expect(await resolve({ driver: 'containerless' })).toBe('plan')
    // Remembered for some other tool, so a tool that lacks it falls through
    // rather than being refused — the user picked it for a different agent.
    expect(await resolve({ tool: 'pi' })).toBe('bypass')
  })

  it('prefers the request over both, and never records it itself', async () => {
    await recordProjectPermissionMode('p', 'plan')
    expect(await resolve({ requested: 'manual' })).toBe('manual')
    // Remembering is the route's job, since only there is the choice known to
    // be a person's rather than a restart's or the spawn policy's.
    expect(await getProjectLastPermissionMode('p')).toBe('plan')
  })

  it('skips the remembered rung under acp, which is bypass-only', async () => {
    await recordProjectPermissionMode('p', 'plan')
    expect(await resolve({ mode: 'acp' })).toBe('bypass')
    await expect(resolve({ mode: 'acp', requested: 'plan' }))
      .rejects.toThrow(/bypass" permissions only/)
  })
})
