import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'

import {
  createWorktree,
  failedCreateCollectsCheckout,
  launchPermissionMode,
  resolveCreate,
  withUpstreamConfigLock,
} from '#domain/worktrees/create'
import { createTempDataDir, cleanupTempDir, createTestRepo } from '@yaac/test-utils/setup'
import { installFakeWorktreeDriver, resetWorktreeDriver } from '@yaac/test-utils/fake-driver'
import { projectDir, repoDir } from '@yaac/shared/project-paths'
import { closeDb } from '#db/client'
import { setGitIdentity } from '#db'
import {
  getProjectRow,
  recordProject,
  recordProjectCreate,
} from '#db/project-store'
import { FALLBACK_MODELS } from '@yaac/shared/tool-providers'

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
 * What a person's create runs with: the request, else what this project last
 * used for the agent, else the fallback. The db is real (an empty temp data
 * dir), because the middle rung IS the recorded row and a mocked read would
 * assert the mock rather than the precedence. No credentials are stored, so
 * the model fallback is the tool's own.
 */
describe('resolveCreate', () => {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    installFakeWorktreeDriver()
    await recordProject({ slug: 'p', remoteUrl: 'git@h:o/r.git', addedAt: 'now' })
  })
  afterEach(async () => {
    resetWorktreeDriver()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('falls back per field when nothing is remembered', async () => {
    expect(await resolveCreate('p', {})).toEqual({
      tool: 'claude', model: FALLBACK_MODELS.claude, permissionMode: 'bypass', mode: 'tui',
    })
    // The posture fallback is the driver's: containerless acts as the user.
    installFakeWorktreeDriver({ kind: 'containerless' })
    expect((await resolveCreate('p', { tool: 'codex' }))).toMatchObject({
      model: FALLBACK_MODELS.codex, permissionMode: 'accept-edits',
    })
  })

  it('reopens on the last agent and what it was last created with', async () => {
    await recordProjectCreate('p', 'claude', { model: 'claude-sonnet-5' })
    await recordProjectCreate('p', 'codex', { model: 'gpt-5.5', permissionMode: 'plan', mode: 'acp' })

    // The mode is not taken from memory for the route's callers — the CLI
    // can only show a terminal — so codex opens in `tui`, where plan exists.
    expect(await resolveCreate('p', {})).toEqual({
      tool: 'codex', model: 'gpt-5.5', permissionMode: 'plan', mode: 'tui',
    })
    // The pool warms what the webapp would send, remembered mode included —
    // and codex's chat adapter has no plan mode, so the remembered posture
    // falls through to the default rather than being refused.
    expect(await resolveCreate('p', {}, { modeFromMemory: true })).toEqual({
      tool: 'codex', model: 'gpt-5.5', permissionMode: 'bypass', mode: 'acp',
    })
    // Another agent brings its own memory.
    expect(await resolveCreate('p', { tool: 'claude' })).toMatchObject({ model: 'claude-sonnet-5' })
  })

  it('prefers the request over memory, and never records it itself', async () => {
    await recordProjectCreate('p', 'claude', { model: 'claude-sonnet-5', permissionMode: 'plan' })
    expect(await resolveCreate('p', { tool: 'claude', model: 'claude-opus-5', permissionMode: 'manual' }))
      .toMatchObject({ model: 'claude-opus-5', permissionMode: 'manual' })
    // Remembering is the route's job, since only there is the choice known to
    // be a person's rather than a restart's or the spawn policy's.
    expect((await getProjectRow('p'))?.createDefaults.claude)
      .toEqual({ model: 'claude-sonnet-5', permissionMode: 'plan' })
  })

  it('refuses a named posture the agent lacks under the named mode', async () => {
    await expect(resolveCreate('p', { tool: 'pi', permissionMode: 'plan' })).rejects.toThrow(/pi has no "plan"/)
    await expect(resolveCreate('p', { tool: 'codex', permissionMode: 'plan', mode: 'acp' }))
      .rejects.toThrow(/under acp/)
  })
})

/**
 * The git identity a create commits under, and where it comes from.
 *
 * Only the identity gate is exercised: the create is allowed to fail at the
 * next gate (no credential is configured for the project's remote), and
 * which of the two errors comes back is what says whether an identity was
 * found.
 *
 * The setting is the whole chain: no fallback to the SERVER HOST's `git
 * config --global`, which only someone with a shell there could change, and
 * which under `k8s` answers nothing at all, since the server is a pod whose
 * `$HOME` is an ephemeral image layer.
 */
describe('createWorktree git identity', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    installFakeWorktreeDriver()
    await fs.mkdir(projectDir('demo'), { recursive: true })
    // A real repo and a row naming its remote, so the create reaches the
    // credential gate instead of dying on an unknown project.
    await createTestRepo(repoDir('demo'))
    await recordProject({ slug: 'demo', remoteUrl: 'https://github.com/o/r.git', addedAt: '2026-01-01T00:00:00.000Z' })
  })

  afterEach(async () => {
    resetWorktreeDriver()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  /** The failure that means "an identity was found and the create moved on". */
  const PAST_THE_GATE = /No git credential configured/
  const NO_IDENTITY = /No git identity is set on this server/

  it('commits under the identity the server setting holds', async () => {
    await setGitIdentity({ name: 'Ada', email: 'ada@example.com' })

    await expect(createWorktree('demo', {})).rejects.toThrow(PAST_THE_GATE)
  })

  it('gets a yaac-mama spawn past the gate on the same setting', async () => {
    // The option shape `decideSpawn` sends for a spawned sibling: a prompt, a
    // minted id, and nothing about who is committing. Asserted on its own
    // because an in-session orchestrator that cannot spawn a worker is the
    // failure this rung exists to prevent.
    await setGitIdentity({ name: 'Ada', email: 'ada@example.com' })

    await expect(createWorktree('demo', {
      tool: 'codex',
      initialPrompt: 'write the report',
      worktreeId: 'minted-id',
    })).rejects.toThrow(PAST_THE_GATE)
  })

  it('refuses when the server has none, naming where to set one', async () => {
    // Nothing is read off a host to fill this in, so the remedy has to be
    // something a client can actually do — including a client with no shell
    // on the server at all.
    await expect(createWorktree('demo', {})).rejects.toThrow(NO_IDENTITY)
    await expect(createWorktree('demo', {})).rejects.toThrow(/Settings/)
  })
})
