import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'

import {
  createWorkspace,
  failedCreateCollectsCheckout,
  launchPermissionMode,
  resolveCreate,
} from '#domain/workspaces/create'
import { createTempDataDir, cleanupTempDir, createTestRepo } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { projectDir, repoDir } from '@yaac/shared/project-paths'
import { closeDb } from '#db/client'
import { getWorkspaceRow, insertGitCredential, setGitIdentity, setProjectGitCredential, type WorkspaceRow } from '#db'
import {
  getProjectRow,
  recordProject,
  recordProjectCreate,
} from '#db/project-store'
import { FALLBACK_MODELS } from '@yaac/shared/tool-providers'
import type { PermissionMode } from '@yaac/shared/types'

// The rule a failed create's rollback consults before removing a checkout.
// Both exclusions are here because getting either backwards destroys work
// that exists in no other copy — a resumed workspace's diff, or a spare's
// checkout pulled out from under the sweep that is about to collect it.
describe('failedCreateCollectsCheckout', () => {
  it('collects a fresh create’s own checkout', () => {
    expect(failedCreateCollectsCheckout({})).toBe(true)
    expect(failedCreateCollectsCheckout({ resume: false, prewarm: false })).toBe(true)
  })

  it('never collects a resumed workspace’s checkout — that is the work the user came back for', () => {
    expect(failedCreateCollectsCheckout({ resume: true })).toBe(false)
  })

  it('leaves a warmed spare to the sweep that collects it on its flag', () => {
    expect(failedCreateCollectsCheckout({ prewarm: true })).toBe(false)
  })
})

/**
 * What a create launches in, absent the project memory rung — the answer
 * every caller reaching createWorkspace directly gets, and where the refusals
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
  // one written by a different build would strand a checkout — but the driver
  // default would hand an old codex `plan` row `bypass` in a container, so it
  // launches in the nearest posture the tool has, else its strictest.
  it('treats a resumed posture as a preference, never looser than the tool can help', () => {
    expect(launch({ resume: true, requested: 'manual' })).toBe('manual')
    for (const driver of ['k8s', 'containerless'] as const) {
      expect(launch({ resume: true, driver, tool: 'codex', requested: 'plan' })).toBe('read-only')
      expect(launch({ resume: true, driver, tool: 'codex', requested: 'manual' })).toBe('read-only')
    }
    expect(launch({ resume: true, tool: 'claude', requested: 'read-only' })).toBe('plan')
    // Nothing that strict under the adapter: its strictest, not the default.
    expect(launch({ resume: true, tool: 'codex', requested: 'read-only', agentMode: 'acp' })).toBe('accept-edits')
    // pi has nothing but bypass.
    expect(launch({ resume: true, tool: 'pi', requested: 'plan' })).toBe('bypass')
    // A row from a newer build, holding a posture this one does not rank,
    // compares with nothing: the strictest, never bypass.
    const unranked = 'dontAsk' as PermissionMode
    expect(launch({ resume: true, tool: 'codex', requested: unranked })).toBe('read-only')
    expect(launch({ resume: true, tool: 'claude', requested: unranked, agentMode: 'acp' })).toBe('plan')
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
    installFakeWorkspaceDriver()
    await recordProject({ slug: 'p', remoteUrl: 'git@h:o/r.git', addedAt: 'now' })
  })
  afterEach(async () => {
    resetWorkspaceDriver()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('falls back per field when nothing is remembered', async () => {
    expect(await resolveCreate('p', {})).toEqual({
      tool: 'claude', model: FALLBACK_MODELS.claude, permissionMode: 'bypass', mode: 'tui',
    })
    // The posture fallback is the driver's: containerless acts as the user.
    installFakeWorkspaceDriver({ kind: 'containerless' })
    expect((await resolveCreate('p', { tool: 'codex' }))).toMatchObject({
      model: FALLBACK_MODELS.codex, permissionMode: 'accept-edits',
    })
  })

  it('reopens on the last agent and what it was last created with', async () => {
    await recordProjectCreate('p', 'claude', { model: 'claude-sonnet-5' })
    await recordProjectCreate('p', 'codex', { model: 'gpt-5.5', permissionMode: 'plan', mode: 'acp' })

    // The mode is not taken from memory for the route's callers — the CLI
    // can only show a terminal — so codex opens in `tui`. It has no `plan`
    // there either, so the remembered one becomes its nearest posture no
    // looser — `read-only` — never a default that restrains less.
    expect(await resolveCreate('p', {})).toEqual({
      tool: 'codex', model: 'gpt-5.5', permissionMode: 'read-only', mode: 'tui',
    })
    // The pool warms what the webapp would send, remembered mode included —
    // and codex's chat adapter has nothing that strict, so the remembered
    // posture lands on the adapter's strictest rather than being refused, and
    // never on the container default of bypass.
    expect(await resolveCreate('p', {}, { modeFromMemory: true })).toEqual({
      tool: 'codex', model: 'gpt-5.5', permissionMode: 'accept-edits', mode: 'acp',
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
describe('createWorkspace git identity', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    installFakeWorkspaceDriver()
    await fs.mkdir(projectDir('demo'), { recursive: true })
    // A real repo and a row naming its remote, so the create reaches the
    // credential gate instead of dying on an unknown project.
    await createTestRepo(repoDir('demo'))
    await recordProject({ slug: 'demo', remoteUrl: 'https://github.com/o/r.git', addedAt: '2026-01-01T00:00:00.000Z' })
  })

  afterEach(async () => {
    resetWorkspaceDriver()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  /** The failure that means "an identity was found and the create moved on". */
  const PAST_THE_GATE = /has no git credential/
  const NO_IDENTITY = /No git identity is set on this server/

  it('commits under the identity the server setting holds', async () => {
    await setGitIdentity({ name: 'Ada', email: 'ada@example.com' })

    await expect(createWorkspace('demo', {})).rejects.toThrow(PAST_THE_GATE)
  })

  it('gets a yaac-mama spawn past the gate on the same setting', async () => {
    // The option shape `decideSpawn` sends for a spawned sibling: a prompt, a
    // minted id, and nothing about who is committing. Asserted on its own
    // because an in-session orchestrator that cannot spawn a worker is the
    // failure this rung exists to prevent.
    await setGitIdentity({ name: 'Ada', email: 'ada@example.com' })

    await expect(createWorkspace('demo', {
      tool: 'codex',
      initialPrompt: 'write the report',
      workspaceId: 'minted-id',
    })).rejects.toThrow(PAST_THE_GATE)
  })

  it('refuses when the server has none, naming where to set one', async () => {
    // Nothing is read off a host to fill this in, so the remedy has to be
    // something a client can actually do — including a client with no shell
    // on the server at all.
    await expect(createWorkspace('demo', {})).rejects.toThrow(NO_IDENTITY)
    await expect(createWorkspace('demo', {})).rejects.toThrow(/Settings/)
  })
})

describe('createWorkspace base branch', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    await fs.mkdir(projectDir('demo'), { recursive: true })
    await createTestRepo(repoDir('demo'))
    await recordProject({ slug: 'demo', remoteUrl: 'https://github.com/o/r.git', addedAt: '2026-01-01T00:00:00.000Z' })
    await setGitIdentity({ name: 'Ada', email: 'ada@example.com' })
    const cred = await insertGitCredential({ name: 'gh', kind: 'https', secret: 'ghp_x' })
    await setProjectGitCredential('demo', cred.id, null)
  })

  afterEach(async () => {
    resetWorkspaceDriver()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  /** The row as the first provisioning leg sees it — the create is then
   *  stopped there, since nothing after it bears on what was recorded. */
  async function rowAtProvisioning(
    workspaceId: string,
    options: Parameters<typeof createWorkspace>[1],
  ): Promise<WorkspaceRow | undefined> {
    let row: WorkspaceRow | undefined
    installFakeWorkspaceDriver({
      prepareImage: async () => {
        row = await getWorkspaceRow('demo', workspaceId)
        throw new Error('stop here')
      },
    })
    await expect(createWorkspace('demo', { workspaceId, ...options })).rejects.toThrow('stop here')
    return row
  }

  it('records the branch it forks from with the row, before anything is provisioned', async () => {
    // A workspace queued after this one defaults to it, and may be queued
    // while this one is still provisioning — so it cannot wait on the
    // checkout. The requested branch, else the clone's default.
    expect((await rowAtProvisioning('wt-1', { branch: 'release' }))?.baseBranch).toBe('release')
    const fallback = (await rowAtProvisioning('wt-2', {}))?.baseBranch
    expect(fallback).toMatch(/^(main|master)$/)
  })
})
