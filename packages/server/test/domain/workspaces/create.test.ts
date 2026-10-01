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
import { getWorkspaceRow, insertGitCredential, setGitIdentity, setProjectGitCredential, setTimeZone, type WorkspaceRow } from '#db'
import {
  getProjectRow,
  recordProject,
  recordProjectCreate,
} from '#db/project-store'
import { FALLBACK_MODELS } from '@yaac/shared/tool-providers'
import type { PermissionMode } from '@yaac/shared/types'

// Whether a failed create's rollback removes the checkout. Getting either
// exclusion wrong destroys the only copy of work: a resumed workspace's diff,
// or a spare's checkout that its own sweep will collect.
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
 * The permission mode a create launches in, ignoring project memory, and
 * where invalid modes are refused. The driver kind is a parameter, so the
 * spawn policy can use this without a registered driver.
 */
describe('launchPermissionMode', () => {
  const launch = (args: Partial<Parameters<typeof launchPermissionMode>[0]> = {}) =>
    launchPermissionMode({ tool: 'claude', driver: 'k8s', ...args })

  it('falls back to the driver default when nothing was asked for', () => {
    // In a container, prompting protects nothing. Containerless runs as the
    // user on their machine, so shells and out-of-tree writes ask.
    expect(launch()).toBe('bypass')
    expect(launch({ driver: 'containerless' })).toBe('accept-edits')
    // pi has no permission system, so it is always bypass.
    expect(launch({ driver: 'containerless', tool: 'pi' })).toBe('bypass')
  })

  it('refuses a posture the tool does not have, naming the ones it does', () => {
    expect(() => launch({ tool: 'pi', requested: 'plan' }))
      .toThrow(/pi has no "plan" permission mode; it supports: bypass/)
    // opencode lacks `auto` but has the other modes.
    expect(() => launch({ tool: 'opencode', requested: 'auto' })).toThrow(/no "auto"/)
    expect(launch({ tool: 'opencode', requested: 'plan' })).toBe('plan')
  })

  // A restart reuses the row's mode. Refusing one from another build would
  // strand a checkout, and the driver default could be looser (bypass), so it
  // launches in the nearest mode the tool has, else its strictest.
  it('treats a resumed posture as a preference, never looser than the tool can help', () => {
    expect(launch({ resume: true, requested: 'manual' })).toBe('manual')
    for (const driver of ['k8s', 'containerless'] as const) {
      expect(launch({ resume: true, driver, tool: 'codex', requested: 'plan' })).toBe('read-only')
      expect(launch({ resume: true, driver, tool: 'codex', requested: 'manual' })).toBe('read-only')
    }
    expect(launch({ resume: true, tool: 'claude', requested: 'read-only' })).toBe('plan')
    // Nothing that strict under the ACP adapter: its strictest mode.
    expect(launch({ resume: true, tool: 'codex', requested: 'read-only', agentMode: 'acp' })).toBe('accept-edits')
    // pi has nothing but bypass.
    expect(launch({ resume: true, tool: 'pi', requested: 'plan' })).toBe('bypass')
    // A mode this build does not know gets the strictest, never bypass.
    const unranked = 'dontAsk' as PermissionMode
    expect(launch({ resume: true, tool: 'codex', requested: unranked })).toBe('read-only')
    expect(launch({ resume: true, tool: 'claude', requested: unranked, agentMode: 'acp' })).toBe('plan')
  })
})

/**
 * A user's create settings: the request, else what the project last used
 * for that agent, else the fallback. The DB is real so the recorded row is
 * tested. No credentials are stored, so the model falls back to the tool's
 * default.
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
    // The permission-mode fallback comes from the driver.
    installFakeWorkspaceDriver({ kind: 'containerless' })
    expect((await resolveCreate('p', { tool: 'codex' }))).toMatchObject({
      model: FALLBACK_MODELS.codex, permissionMode: 'accept-edits',
    })
  })

  it('reopens on the last agent and what it was last created with', async () => {
    await recordProjectCreate('p', 'claude', { model: 'claude-sonnet-5' })
    await recordProjectCreate('p', 'codex', { model: 'gpt-5.5', permissionMode: 'plan', mode: 'acp' })

    // The agent mode is not remembered for the route (the CLI can only show
    // a terminal), so codex opens in `tui`, which lacks `plan`; the nearest
    // stricter mode, `read-only`, is used.
    expect(await resolveCreate('p', {})).toEqual({
      tool: 'codex', model: 'gpt-5.5', permissionMode: 'read-only', mode: 'tui',
    })
    // The spare pool warms what the webapp would send, including the
    // remembered agent mode. codex's ACP adapter has nothing as strict as
    // `plan`, so its strictest mode is used, not bypass.
    expect(await resolveCreate('p', {}, { modeFromMemory: true })).toEqual({
      tool: 'codex', model: 'gpt-5.5', permissionMode: 'accept-edits', mode: 'acp',
    })
    // Each agent has its own remembered settings.
    expect(await resolveCreate('p', { tool: 'claude' })).toMatchObject({ model: 'claude-sonnet-5' })
  })

  it('prefers the request over memory, and never records it itself', async () => {
    await recordProjectCreate('p', 'claude', { model: 'claude-sonnet-5', permissionMode: 'plan' })
    expect(await resolveCreate('p', { tool: 'claude', model: 'claude-opus-5', permissionMode: 'manual' }))
      .toMatchObject({ model: 'claude-opus-5', permissionMode: 'manual' })
    // The route records choices, since only there are they known to be a
    // user's.
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
 * The git identity a create commits under. The create then fails at the next
 * check (no git credential), and which error comes back shows whether an
 * identity was found.
 *
 * The server setting is the only source. There is no fallback to the server
 * host's `git config --global`: only someone with a shell there could change
 * it, and under k8s the server pod's `$HOME` is ephemeral.
 */
describe('createWorkspace git identity', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    installFakeWorkspaceDriver()
    await fs.mkdir(projectDir('demo'), { recursive: true })
    // A real repo and project row, so the create reaches the credential
    // check.
    await createTestRepo(repoDir('demo'))
    await recordProject({ slug: 'demo', remoteUrl: 'https://github.com/o/r.git', addedAt: '2026-01-01T00:00:00.000Z' })
  })

  afterEach(async () => {
    resetWorkspaceDriver()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  /** The error that means an identity was found and the create moved on. */
  const PAST_THE_GATE = /has no git credential/
  const NO_IDENTITY = /No git identity is set on this server/

  it('commits under the identity the server setting holds', async () => {
    await setGitIdentity({ name: 'Ada', email: 'ada@example.com' })

    await expect(createWorkspace('demo', {})).rejects.toThrow(PAST_THE_GATE)
  })

  it('gets a yaac-mama spawn past the gate on the same setting', async () => {
    // The options `decideSpawn` sends: a prompt and a minted id, with no
    // committer identity.
    await setGitIdentity({ name: 'Ada', email: 'ada@example.com' })

    await expect(createWorkspace('demo', {
      tool: 'codex',
      initialPrompt: 'write the report',
      workspaceId: 'minted-id',
    })).rejects.toThrow(PAST_THE_GATE)
  })

  it('refuses when the server has none, naming where to set one', async () => {
    // The remedy must be something a client with no shell on the server can
    // do.
    await expect(createWorkspace('demo', {})).rejects.toThrow(NO_IDENTITY)
    await expect(createWorkspace('demo', {})).rejects.toThrow(/Settings/)
  })
})

describe('createWorkspace provisioning', () => {
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

  /** The workspace row when provisioning starts; the create is stopped
   *  there. */
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
    // A workspace queued after this one defaults to this branch and may be
    // queued mid-provisioning, so it is recorded up front: the requested
    // branch, else the clone's default.
    expect((await rowAtProvisioning('wt-1', { branch: 'release' }))?.baseBranch).toBe('release')
    const fallback = (await rowAtProvisioning('wt-2', {}))?.baseBranch
    expect(fallback).toMatch(/^(main|master)$/)
  })

  it('launches in the time zone clients report, and records it', async () => {
    /** The env and row at launch; the create is stopped there. */
    const launched = async (workspaceId: string): Promise<{ env: string[]; row?: WorkspaceRow }> => {
      let env: string[] = []
      let row: WorkspaceRow | undefined
      installFakeWorkspaceDriver({
        launch: async (spec) => {
          env = spec.env
          row = await getWorkspaceRow('demo', workspaceId)
          throw new Error('stop here')
        },
      })
      await expect(createWorkspace('demo', { workspaceId })).rejects.toThrow('stop here')
      return { env, row }
    }
    // A pod would otherwise run in UTC, whatever zone the user is in.
    const before = await launched('wt-3')
    expect(before.env.filter((e) => e.startsWith('TZ='))).toEqual([])
    expect(before.row?.timeZone).toBeUndefined()

    await setTimeZone('Asia/Tokyo', false)
    const after = await launched('wt-4')
    expect(after.env).toContain('TZ=Asia/Tokyo')
    // Recorded, so a spare claim can tell which zone it launched in.
    expect(after.row?.timeZone).toBe('Asia/Tokyo')
  })
})
