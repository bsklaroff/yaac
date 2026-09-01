import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import simpleGit from 'simple-git'
import type * as sharedGitModule from '@yaac/shared/git'

// The one process boundary onto the host's git CONFIG. Mocked because the
// identity chain's bottom rung is "what this machine has configured", and a
// developer machine always has something — so the absent case, which is the
// whole reason the rungs above it exist, is otherwise unreachable.
const mockGitUserConfig = vi.hoisted(() => vi.fn())
vi.mock('@yaac/shared/git', async (importOriginal) => ({
  ...(await importOriginal<typeof sharedGitModule>()),
  getGitUserConfig: mockGitUserConfig,
}))

import {
  createWorktree,
  failedCreateCollectsCheckout,
  launchPermissionMode,
  resolvePermissionMode,
  withUpstreamConfigLock,
} from '#domain/worktrees/create'
import { createTempDataDir, cleanupTempDir, createTestRepo } from '@yaac/test-utils/setup'
import { installFakeWorktreeDriver, resetWorktreeDriver } from '@yaac/test-utils/fake-driver'
import { projectDir, repoDir } from '@yaac/shared/project-paths'
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
    launchPermissionMode({ tool: 'claude', driver: 'k8s', ...args })

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

  // A restart re-states the row's posture rather than a person's. Refusing
  // one written by a different build would strand a checkout, and stranding
  // work is worse than launching at this tool's default.
  it('treats a resumed posture as a preference, not a demand', () => {
    expect(launch({ resume: true, tool: 'pi', requested: 'plan' })).toBe('bypass')
    expect(launch({ resume: true, requested: 'manual' })).toBe('manual')
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
      projectSlug: 'p', tool: 'claude', driver: 'k8s', ...args,
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

  // The posture is a property of the worktree, not of how its agent is
  // presented: a chat conversation enforces one by telling the adapter and
  // asking the pane about the rest, so there is no mode-shaped exception here
  // — which is why the resolver takes no mode at all.
  it('answers the same for a conversation as for a terminal', async () => {
    await recordProjectPermissionMode('p', 'plan')
    expect(await resolve()).toBe('plan')
    expect(await resolve({ requested: 'accept-edits' })).toBe('accept-edits')
  })
})

/**
 * The git identity a create commits under, and where it comes from.
 *
 * Only the identity gate is exercised: the create is allowed to fail at the
 * next gate (no credential is configured for the project's remote), and
 * which of the two errors comes back is what says whether an identity was
 * found. Precedence is read off `getGitUserConfig` — the process boundary
 * onto the host's git config, mocked here because a developer machine has a
 * real one and the "nothing configured" case is otherwise untestable.
 */
describe('createWorktree git identity', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    installFakeWorktreeDriver()
    await fs.mkdir(projectDir('demo'), { recursive: true })
    // A real repo with an origin, so the create reaches the credential gate
    // instead of dying on an unreadable remote.
    await createTestRepo(repoDir('demo'))
    await simpleGit(repoDir('demo')).addRemote('origin', 'https://github.com/o/r.git')
    mockGitUserConfig.mockResolvedValue(null)
  })

  afterEach(async () => {
    resetWorktreeDriver()
    // This project does not auto-unstub, and a leaked YAAC_SERVER_GIT_EMAIL
    // would supply the very identity the next case is about not having.
    vi.unstubAllEnvs()
    mockGitUserConfig.mockReset()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  /** The failure that means "an identity was found and the create moved on". */
  const PAST_THE_GATE = /No git credential configured/
  const NO_IDENTITY = /No git identity available/

  it('prefers the caller’s identity and never reads a config for one', async () => {
    await expect(createWorktree('demo', { gitUser: { name: 'Ada', email: 'a@e' } }))
      .rejects.toThrow(PAST_THE_GATE)
    expect(mockGitUserConfig).not.toHaveBeenCalled()
  })

  it('takes the identity its environment states before reading a config', async () => {
    // The rung that makes the fallback work at all under the k8s driver: the
    // server is a pod whose `$HOME` is an ephemeral image layer, so the
    // global config it would otherwise read answers nothing.
    vi.stubEnv('YAAC_SERVER_GIT_NAME', 'Ada')
    vi.stubEnv('YAAC_SERVER_GIT_EMAIL', 'ada@example.com')

    await expect(createWorktree('demo', {})).rejects.toThrow(PAST_THE_GATE)
    expect(mockGitUserConfig).not.toHaveBeenCalled()
  })

  it('gets a yaac-mama spawn past the gate on the environment identity alone', async () => {
    // The option shape `decideSpawn` sends for a spawned sibling: a prompt,
    // a minted id, no identity. Under the k8s driver this path had no
    // identity available at all, so an in-session orchestrator could spawn
    // no worker — which is why it is asserted as its own case rather than
    // left to the empty-options one above.
    vi.stubEnv('YAAC_SERVER_GIT_NAME', 'Ada')
    vi.stubEnv('YAAC_SERVER_GIT_EMAIL', 'ada@example.com')

    await expect(createWorktree('demo', {
      tool: 'codex',
      initialPrompt: 'write the report',
      worktreeId: 'minted-id',
    })).rejects.toThrow(PAST_THE_GATE)
  })

  it('ignores a half-stated environment identity', async () => {
    // Committing as a name with no email is not a lesser version of having
    // an identity — git refuses it — so a half-set pair must fall through.
    vi.stubEnv('YAAC_SERVER_GIT_NAME', 'Ada')

    await expect(createWorktree('demo', {})).rejects.toThrow(NO_IDENTITY)
    expect(mockGitUserConfig).toHaveBeenCalled()
  })

  it('falls back to the global git config, which is the containerless answer', async () => {
    mockGitUserConfig.mockResolvedValue({ name: 'Ada', email: 'ada@example.com' })

    await expect(createWorktree('demo', {})).rejects.toThrow(PAST_THE_GATE)
    expect(mockGitUserConfig).toHaveBeenCalled()
  })

  it('refuses when all three are absent, naming what would supply one', async () => {
    await expect(createWorktree('demo', {})).rejects.toThrow(NO_IDENTITY)
    // The remedy has to name the re-install: on a pod install, setting the
    // global config alone changes nothing the server can see.
    await expect(createWorktree('demo', {})).rejects.toThrow(/cluster install/)
  })
})
