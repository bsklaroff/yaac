import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

import { createWorkspace, resolveCreate } from '#domain/workspaces/create'
import {
  clearAllProvisioningForTests,
  inFlightWorkspaceIds,
  listProvisioning,
  registerProvisioning,
  runProvisioned,
} from '#domain/workspaces/provisioning'
import { setWorkspaceBinDir } from '#domain/workspaces/workspace-bin'
import { setProjectEnvVar } from '#domain/projects'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { git } from '@yaac/test-utils/git'
import { recordTestProject, seedProject } from '@yaac/test-utils/project-fixture'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver, substrateFixture } from '@yaac/test-utils/fake-driver'
import {
  cachedPackagesDir,
  claudeDir,
  codexDir,
  opencodeCheckpointDir,
  opencodeConfigDir,
  opencodeDataDir,
  piDir,
  repoDir,
  workspaceDir,
} from '@yaac/shared/project-paths'
import { CONTAINER_TMUX_DIR, projectConfigDir } from '@yaac/shared/paths'
import {
  PLACEHOLDER_API_KEY, PLACEHOLDER_GH_TOKEN, PLACEHOLDER_OPENCODE_API_KEY, PLACEHOLDER_PI_API_KEY, saveCodexOAuthBundle, saveToolAuth,
} from '@yaac/shared/tool-auth'
import { closeDb } from '#db/client'
import {
  applyWorkspaceEvent,
  getWorkspaceRow,
  insertGitCredential,
  listWorkspaceAgentSessions,
  setGitIdentity,
  setProjectGitCredential,
  setTimeZone,
  type WorkspaceRow,
} from '#db'
import {
  getProjectRow,
  recordProject,
  recordProjectCreate,
} from '#db/project-store'
import { FALLBACK_MODELS } from '@yaac/shared/tool-providers'
import { WorkspaceExecError, type WorkspaceDriver, type WorkspaceSpec } from '#drivers/contract'
import type { AgentTool, PermissionMode, YaacConfig } from '@yaac/shared/types'

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
      tool: 'claude', model: FALLBACK_MODELS.claude, permissionMode: 'bypass', mode: 'acp',
    })
    // The permission-mode fallback comes from the driver.
    // In a container, prompting protects nothing. Containerless runs as the
    // user on their machine, so shells and out-of-tree writes ask; pi has no
    // permission system, so it is always bypass.
    installFakeWorkspaceDriver({ kind: 'containerless' })
    expect((await resolveCreate('p', { tool: 'codex' }))).toMatchObject({
      model: FALLBACK_MODELS.codex, permissionMode: 'accept-edits',
    })
    expect((await resolveCreate('p', { tool: 'pi' })).permissionMode).toBe('bypass')
  })

  it('reopens on the last agent and what it was last created with', async () => {
    await recordProjectCreate('p', 'claude', { model: 'claude-sonnet-5' })
    await recordProjectCreate('p', 'codex', { model: 'gpt-5.5', permissionMode: 'plan', mode: 'acp' })

    // codex lacks `plan`, so the nearest stricter mode, `read-only`, is used.
    expect(await resolveCreate('p', {})).toEqual({
      tool: 'codex', model: 'gpt-5.5', permissionMode: 'read-only', mode: 'acp',
    })
    await recordProjectCreate('p', 'codex', { mode: 'tui' })
    expect((await resolveCreate('p', {})).mode).toBe('tui')
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

  it('refuses a named posture the agent lacks, under either UI, naming the ones it has', async () => {
    await expect(resolveCreate('p', { tool: 'pi', permissionMode: 'plan' }))
      .rejects.toThrow(/pi has no "plan" permission mode; it supports: bypass/)
    await expect(resolveCreate('p', { tool: 'codex', permissionMode: 'plan', mode: 'acp' }))
      .rejects.toThrow(/codex has no "plan"/)
    // opencode lacks `auto` but has the other modes.
    await expect(resolveCreate('p', { tool: 'opencode', permissionMode: 'auto' })).rejects.toThrow(/no "auto"/)
    expect((await resolveCreate('p', { tool: 'opencode', permissionMode: 'plan' })).permissionMode).toBe('plan')
  })
})

/**
 * Creates run to completion against the fake driver over a real project
 * (`seedProject`). The assertions land on what reaches the driver: the
 * launch spec and the commands run in the workspace.
 */
describe('createWorkspace', () => {
  let tmpDir: string
  let specs: WorkspaceSpec[]
  let execs: string[]
  /** Each teardown's `unitOnly`: true keeps the prepared substrate. */
  let destroys: boolean[]
  let deregistered: string[]

  /** Install the fake driver, recording launches and execs; `overrides`
   *  replace verbs for one case. */
  function installDriver(overrides: Partial<WorkspaceDriver> = {}): void {
    installFakeWorkspaceDriver({
      launch: (spec) => {
        specs.push(spec)
        spec.onProgress?.('launching')
        return Promise.resolve(handleFixture({
          workspaceId: spec.workspaceId, jobName: `yaac-demo-${spec.workspaceId}`, tool: spec.tool,
        }))
      },
      exec: (_jobName, cmd) => {
        execs.push(cmd)
        return Promise.resolve({ stdout: '', stderr: '' })
      },
      destroy: (_target, opts) => { destroys.push(opts?.unitOnly === true); return Promise.resolve(true) },
      deregisterWorkspace: (id) => { deregistered.push(id); return Promise.resolve() },
      ...overrides,
    })
  }

  const env = (): string[] => specs.at(-1)!.env
  const execOf = (needle: string): string | undefined => execs.find((c) => c.includes(needle))

  async function writeConfig(config: YaacConfig): Promise<void> {
    await fs.mkdir(projectConfigDir('demo'), { recursive: true })
    await fs.writeFile(path.join(projectConfigDir('demo'), 'yaac-config.json'), JSON.stringify(config))
  }

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    await seedProject()
    specs = []
    execs = []
    destroys = []
    deregistered = []
    installDriver()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    setWorkspaceBinDir(null)
    clearAllProvisioningForTests()
    resetWorkspaceDriver()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('checks out the requested branch, records the row and conversation, and launches the agent', async () => {
    // What the driver reports while it prepares reaches the caller too.
    installDriver({
      prepareImage: (o) => { o.onProgress?.('image ready'); return Promise.resolve('img') },
      prepareSubstrate: (i) => { i.onProgress?.('substrate ready'); return Promise.resolve(substrateFixture()) },
    })
    const progress: string[] = []
    const result = await createWorkspace('demo', {
      mode: 'tui',
      tool: 'codex', branch: 'dev', model: 'gpt-6-sol', initialPrompt: 'ship it',
      onProgress: (m) => progress.push(m),
    })
    const { workspaceId } = result

    expect(result).toEqual({
      workspaceId, jobName: `yaac-demo-${workspaceId}`, tool: 'codex', mode: 'tui', forwardedPorts: [],
    })
    expect(await git(workspaceDir('demo', workspaceId), ['rev-parse', '--abbrev-ref', 'HEAD']))
      .toBe(`agent/${workspaceId}\n`)
    // Stored so a restart relaunches with the user's choice and a spare
    // claim can match on it, and up front: a workspace queued while this
    // one boots defaults to its branch.
    expect(await getWorkspaceRow('demo', workspaceId)).toMatchObject({
      baseBranch: 'dev', permissionMode: 'bypass', mode: 'tui', model: 'gpt-6-sol',
    })
    expect(await listWorkspaceAgentSessions('demo', workspaceId)).toEqual([expect.objectContaining({
      tool: 'codex', agentSessionId: workspaceId, firstPrompt: 'ship it', model: 'gpt-6-sol',
    })])
    expect(progress).toEqual(expect.arrayContaining([
      'image ready', 'substrate ready', 'launching', 'Creating workspace from dev...', 'Starting Codex...',
      'Sending initial prompt...',
    ]))

    // The clone borrows from the main clone at the path the server sees it
    // at, mounted read-only there.
    expect(execOf('objects/info/alternates')).toContain(`'${repoDir('demo')}/.git/objects'`)
    const { mounts, postStartExec, preStopExec } = specs[0]
    expect(mounts).toContainEqual({
      source: { kind: 'hostPath', path: `${repoDir('demo')}/.git` },
      mountPath: `${repoDir('demo')}/.git`,
      readOnly: true,
    })
    // The tmux socket needs no host dir: every client reaches it in-pod.
    expect(mounts).toContainEqual({ source: { kind: 'emptyDir' }, mountPath: CONTAINER_TMUX_DIR })
    expect(postStartExec).toEqual(['/usr/local/bin/yaac-workspace-init'])
    // The shipped helper commands are mounted where the agent finds them.
    const helpers = mounts.map((m) => m.mountPath).filter((p) => p.startsWith('/usr/local/bin/'))
    expect(helpers).toEqual(expect.arrayContaining(['/usr/local/bin/yaac-mama', '/usr/local/bin/yaac-watch-prs']))
    expect(preStopExec).toEqual(['/usr/local/bin/yaac-opencode-checkpoint', 'stop'])
    // Every tool's home is mounted whatever the tool, since spares are
    // retoolable. A package tree shared by every pod would be a channel
    // between them, so the project's package cache is not.
    const projectId = (await getProjectRow('demo'))!.id
    const sources = mounts.flatMap((m) => (m.source.kind === 'hostPath' ? [m.source.path] : []))
    expect(sources).toEqual(expect.arrayContaining([
      claudeDir('demo'), codexDir('demo'), opencodeConfigDir('demo'), piDir('demo'),
      opencodeCheckpointDir('demo', workspaceId), opencodeDataDir(projectId, workspaceId),
    ]))
    expect(sources).not.toContain(cachedPackagesDir(projectId))
    expect(env()).toEqual(expect.arrayContaining([
      `YAAC_WORKSPACE_ID=${workspaceId}`, 'YAAC_TOOL=codex', 'YAAC_GIT_NAME=Ada', 'YAAC_GIT_EMAIL=ada@example.com',
      `YAAC_STATUS_RIGHT= demo ${workspaceId.slice(0, 8)} `,
    ]))
    expect(execOf('respawn-window')).toMatch(/respawn-window -k -t yaac:codex 'codex .* --yolo --model gpt-6-sol'/)
    // The workspace runs as the server's uid, so a chown would only corrupt
    // host-side ownership.
    expect(execs.some((c) => c.includes('chown') || c.startsWith('sudo '))).toBe(false)
    // Onboarding state is seeded whatever the tool, since spares are
    // retoolable.
    const claudeJson = JSON.parse(
      await fs.readFile(path.join(claudeDir('demo'), '.claude.json'), 'utf8'),
    ) as { hasCompletedOnboarding?: boolean }
    expect(claudeJson.hasCompletedOnboarding).toBe(true)
  })

  // Every credentialed tool's key is seeded on any workspace (a spare may be
  // retooled at claim), as a placeholder the proxy swaps. opencode and pi
  // each read theirs from a variable of their own, so neither collides with
  // claude's or codex's.
  it.each<{ name: string; tool: AgentTool; key: string; kind: 'api-key' | 'oauth'; provider?: string; want: Record<string, string>; not: string[] }>([
    { name: 'claude api key', tool: 'claude', key: 'sk-ant', kind: 'api-key', want: { ANTHROPIC_API_KEY: PLACEHOLDER_API_KEY }, not: [] },
    { name: 'opencode on openrouter', tool: 'opencode', key: 'sk-or', kind: 'api-key', provider: 'openrouter', want: { YAAC_OPENCODE_KEY_OPENROUTER: PLACEHOLDER_OPENCODE_API_KEY, OPENCODE_CONFIG: '/home/yaac/.config/opencode/yaac-keys/openrouter.json' }, not: ['OPENROUTER_API_KEY'] },
    { name: 'opencode on neuralwatt', tool: 'opencode', key: 'nw', kind: 'api-key', provider: 'neuralwatt', want: { YAAC_OPENCODE_KEY_NEURALWATT: PLACEHOLDER_OPENCODE_API_KEY }, not: ['NEURALWATT_API_KEY', 'YAAC_OPENCODE_KEY_OPENROUTER'] },
    { name: 'pi on anthropic', tool: 'pi', key: 'sk-ant', kind: 'api-key', provider: 'anthropic', want: { YAAC_PI_KEY_ANTHROPIC: PLACEHOLDER_PI_API_KEY }, not: ['ANTHROPIC_API_KEY'] },
    { name: 'codex api key', tool: 'codex', key: 'sk-oai', kind: 'api-key', want: { OPENAI_API_KEY: PLACEHOLDER_API_KEY }, not: [] },
    // Under codex OAuth this var would switch it into api-key mode.
    { name: 'codex OAuth', tool: 'codex', key: 'access', kind: 'oauth', want: {}, not: ['OPENAI_API_KEY'] },
  ])('seeds the env a $name credential needs, on a workspace of any tool', async ({ tool, key, kind, provider, want, not }) => {
    if (kind === 'oauth') {
      await saveCodexOAuthBundle({
        accessToken: key, refreshToken: 'r', idTokenRawJwt: 'h.p.s', expiresAt: 0, lastRefresh: '2026-01-01T00:00:00.000Z',
      })
    } else {
      await saveToolAuth(tool, key, kind, provider)
    }
    await createWorkspace('demo', { mode: 'tui', tool: 'claude' })

    expect(env()).toEqual(expect.arrayContaining(Object.entries(want).map(([name, value]) => `${name}=${value}`)))
    expect(specs[0].secretEnvKeys).toEqual(expect.arrayContaining(Object.keys(want).filter((n) => n !== 'OPENCODE_CONFIG')))
    const names = env().map((e) => e.split('=')[0])
    for (const name of not) expect(names).not.toContain(name)
    expect(env()).toEqual(expect.arrayContaining([
      'OPENCODE_DISABLE_AUTOUPDATE=1', 'PI_CODING_AGENT_SESSION_DIR=/home/yaac/.yaac-pi-sessions', 'PI_SKIP_VERSION_CHECK=1',
    ]))
  })

  it('gives opencode and pi each their own key for one provider, in the config each tool reads', async () => {
    installDriver({ kind: 'containerless' })
    await saveToolAuth('opencode', 'sk-or-oc', 'api-key', 'openrouter')
    await saveToolAuth('pi', 'sk-or-pi', 'api-key', 'openrouter')
    // A user's own pi config is kept.
    const models = path.join(piDir('demo'), 'agent', 'models.json')
    await fs.mkdir(path.dirname(models), { recursive: true })
    await fs.writeFile(models, JSON.stringify({ providers: { ollama: { baseUrl: 'http://localhost:11434/v1' } } }))

    await createWorkspace('demo', { tool: 'claude' })

    expect(env()).toEqual(expect.arrayContaining([
      'YAAC_OPENCODE_KEY_OPENROUTER=sk-or-oc', 'YAAC_PI_KEY_OPENROUTER=sk-or-pi',
    ]))
    expect(env().map((e) => e.split('=')[0])).not.toContain('OPENROUTER_API_KEY')
    expect(JSON.parse(await fs.readFile(path.join(opencodeConfigDir('demo'), 'yaac-keys', 'openrouter.json'), 'utf8')))
      .toEqual({ provider: { openrouter: { env: ['YAAC_OPENCODE_KEY_OPENROUTER', 'OPENROUTER_API_KEY'] } } })
    expect(JSON.parse(await fs.readFile(models, 'utf8'))).toEqual({ providers: {
      ollama: { baseUrl: 'http://localhost:11434/v1' },
      openrouter: { apiKey: '!printenv YAAC_PI_KEY_OPENROUTER || printenv OPENROUTER_API_KEY' },
    } })
  })

  it('lets a project override TZ and OPENCODE_CONFIG, takes a variable matching yaac\'s, and refuses one that conflicts', async () => {
    await setTimeZone('Asia/Tokyo', false)
    await saveToolAuth('opencode', 'sk-or', 'api-key', 'openrouter')
    await setProjectEnvVar('demo', { name: 'TZ', value: 'Europe/Paris' })
    await setProjectEnvVar('demo', { name: 'OPENCODE_CONFIG', value: '/workspace/opencode.json' })
    await setProjectEnvVar('demo', { name: 'OPENCODE_DISABLE_AUTOUPDATE', value: '1' })
    await createWorkspace('demo', {})
    expect(env().filter((e) => e.startsWith('TZ='))).toEqual(['TZ=Europe/Paris'])
    expect(env().filter((e) => e.startsWith('OPENCODE_CONFIG='))).toEqual(['OPENCODE_CONFIG=/workspace/opencode.json'])

    await setProjectEnvVar('demo', { name: 'PI_SKIP_VERSION_CHECK', value: '0' })
    await expect(createWorkspace('demo', {})).rejects.toThrow(
      "the project's environment variable PI_SKIP_VERSION_CHECK conflicts with the value yaac sets for it",
    )
    // Refused before anything launched.
    expect(specs).toHaveLength(1)
  })

  // `gh` is logged in with the git token for a GitHub HTTPS remote, unless
  // the project wires a GitHub token of its own.
  it.each<{ name: string; remote?: string; plain?: string; secret?: string; want: string | undefined }>([
    { name: 'a github.com remote', want: PLACEHOLDER_GH_TOKEN },
    { name: 'a non-GitHub remote', remote: 'https://gitlab.com/o/r.git', want: undefined },
    { name: 'a project GH_TOKEN', plain: 'GH_TOKEN', want: 'ghp_user' },
    { name: 'a proxied GITHUB_TOKEN secret', secret: 'GITHUB_TOKEN', want: undefined },
  ])('seeds GH_TOKEN as it should for $name', async ({ remote, plain, secret, want }) => {
    if (remote !== undefined) await recordProject({ slug: 'demo', remoteUrl: remote, addedAt: '2026-01-01T00:00:00.000Z' })
    if (plain !== undefined) await setProjectEnvVar('demo', { name: plain, value: 'ghp_user' })
    if (secret !== undefined) {
      await setProjectEnvVar('demo', { name: secret, value: 'sekrit', secret: true, rule: { hosts: ['api.github.com'] } })
    }

    await createWorkspace('demo', { mode: 'tui' })

    expect(env().find((e) => e.startsWith('GH_TOKEN='))?.slice('GH_TOKEN='.length)).toBe(want)
  })

  // The server setting is the only source. There is no fallback to the
  // server host's `git config --global`: only someone with a shell there
  // could change it, and under k8s the server pod's `$HOME` is ephemeral.
  it('refuses without a git identity, naming where a client can set one', async () => {
    await setGitIdentity({ name: ' ', email: ' ' })
    await expect(createWorkspace('demo', { mode: 'tui' })).rejects.toThrow(/No git identity is set on this server.*Settings/)
    expect(specs).toEqual([])
  })

  it('seeds claude\'s config and settings, keeping what claude itself wrote', async () => {
    const home = claudeDir('demo')
    const readJson = async (name: string): Promise<Record<string, unknown>> =>
      JSON.parse(await fs.readFile(path.join(home, name), 'utf8')) as Record<string, unknown>
    await fs.mkdir(home, { recursive: true })
    await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({
      oauthAccount: { uuid: 'x' },
      customApiKeyResponses: { approved: ['other-key'], rejected: ['nope'] },
    }))
    // A pod can plant a link in its tool home; following it would let every
    // create rewrite the file it names.
    const target = path.join(tmpDir, 'elsewhere')
    await fs.writeFile(target, 'not yours')
    await fs.symlink(target, path.join(home, 'settings.json'))

    await createWorkspace('demo', { mode: 'tui' })

    const config = await readJson('.claude.json')
    expect(config).toMatchObject({
      oauthAccount: { uuid: 'x' },
      hasCompletedOnboarding: true,
      projects: { '/workspace': { hasTrustDialogAccepted: true } },
      customApiKeyResponses: { approved: ['other-key', PLACEHOLDER_API_KEY], rejected: ['nope'] },
    })
    expect(typeof config.lastOnboardingVersion).toBe('string')
    expect(await fs.readFile(target, 'utf8')).toBe('not yours')
    expect((await fs.lstat(path.join(home, 'settings.json'))).isFile()).toBe(true)
    // Transcripts are kept for 100 years rather than claude's 30 days.
    expect(await readJson('settings.json')).toMatchObject({ skipDangerousModePermissionPrompt: true, cleanupPeriodDays: 36500 })

    // An unreadable config starts over; settings keep their own keys.
    await fs.writeFile(path.join(home, '.claude.json'), 'not json{')
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ theme: 'dark', cleanupPeriodDays: 30 }))
    await createWorkspace('demo', { mode: 'tui' })
    expect(await readJson('.claude.json')).toMatchObject({ hasCompletedOnboarding: true })
    expect(await readJson('settings.json')).toMatchObject({ theme: 'dark', cleanupPeriodDays: 36500 })
  })

  it('trusts each containerless checkout where it is, keeping every root when creates run at once', async () => {
    // A containerless agent runs in the real checkout, so a `/workspace`
    // entry would match nothing. The project's workspaces share one
    // claude.json, and a lost entry opens claude's trust dialog.
    installDriver({ kind: 'containerless' })
    const created = await Promise.all([1, 2, 3].map(() => createWorkspace('demo', { mode: 'tui' })))
    const config = JSON.parse(await fs.readFile(path.join(claudeDir('demo'), '.claude.json'), 'utf8')) as {
      projects: Record<string, unknown>
    }
    for (const { workspaceId } of created) {
      expect(config.projects[await fs.realpath(workspaceDir('demo', workspaceId))]).toEqual({ hasTrustDialogAccepted: true })
    }
    expect(config.projects['/workspace']).toBeUndefined()
  })

  it('stages the helper commands each launch, mounting each read-only onto /usr/local/bin', async () => {
    const src = path.join(tmpDir, 'workspace-bin')
    await fs.mkdir(path.join(src, 'subdir'), { recursive: true })
    for (const name of ['yaac-workspace-init', 'a-tool', '.hidden']) {
      await fs.writeFile(path.join(src, name), '#!/bin/sh\n', { mode: 0o600 })
    }
    setWorkspaceBinDir(src)
    const helpers = (): WorkspaceSpec['mounts'] =>
      specs.at(-1)!.mounts.filter((m) => m.mountPath.startsWith('/usr/local/bin/'))

    await createWorkspace('demo', { mode: 'tui', workspaceId: 'wt-bin' })

    // Regular files only, executable.
    expect(helpers().map((m) => m.mountPath)).toEqual(['/usr/local/bin/a-tool', '/usr/local/bin/yaac-workspace-init'])
    for (const { source, readOnly } of helpers()) {
      expect(source).toMatchObject({ kind: 'hostPath', type: 'File' })
      expect(readOnly).toBe(true)
      expect((await fs.stat((source as { path: string }).path)).mode & 0o777).toBe(0o755)
    }
    const staged = (helpers()[0]?.source as { path: string }).path

    // A relaunch restages from scratch, so a removed command is gone.
    await fs.rm(path.join(src, 'a-tool'))
    await createWorkspace('demo', { mode: 'tui', workspaceId: 'wt-bin', resume: true })
    expect(helpers().map((m) => m.mountPath)).toEqual(['/usr/local/bin/yaac-workspace-init'])
    await expect(fs.access(staged)).rejects.toThrow()

    // Without the init script a pod would have no git identity, tmux or
    // streamd, so a stripped build refuses.
    setWorkspaceBinDir(path.join(tmpDir, 'missing'))
    await expect(createWorkspace('demo', { mode: 'tui' })).rejects.toThrow(/missing yaac-workspace-init/)
  })

  // The window probe is not awaited, so a dead agent's verdict can land
  // after the create resolved. It waits for the create's run and then files
  // a failed row, which leaves the workspace to the reaper.
  it('reports an agent that died right after launch as a failed row, once the create has settled', async () => {
    // The create is held at its prompt delivery, after the probe fired.
    let probed = false
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    installDriver({
      exec: async (_jobName, cmd) => {
        if (cmd.includes('list-windows -t =yaac')) {
          probed = true
          throw new WorkspaceExecError('probe', 1, '', 'codex')
        }
        if (cmd.includes('.yaac-prompt.sh')) await held
        return { stdout: '', stderr: '' }
      },
    })
    registerProvisioning({ workspaceId: 'wt-dead', projectSlug: 'demo', tool: 'codex', kind: 'create' })

    const run = runProvisioned('wt-dead', () => createWorkspace('demo', {
      mode: 'tui',
      workspaceId: 'wt-dead', tool: 'codex', initialPrompt: 'go',
    }))
    // Filed now, the verdict would be erased by the create's success.
    await vi.waitFor(() => { expect(probed).toBe(true) }, { timeout: 30_000 })
    await new Promise((r) => setTimeout(r, 50))
    expect(listProvisioning()[0]?.error).toBeUndefined()
    release()
    await run

    await vi.waitFor(() => {
      expect(listProvisioning()).toMatchObject([{ workspaceId: 'wt-dead', kind: 'create' }])
      expect(listProvisioning()[0]?.error).toMatch(/agent "codex" exited right after launch/)
    }, { timeout: 30_000 })
    expect(inFlightWorkspaceIds()).toEqual([])
  })

  it('opens the init windows and declares the forwards before the agent starts', async () => {
    await writeConfig({
      initCommands: [
        { name: 'backend', commands: ['pnpm dev:backend'] },
        { name: 'frontend', commands: ['pnpm install', "echo 'hi'"], hidePane: true },
      ],
      portForward: [{ containerPort: 3000, hostPortStart: 3000 }],
    })

    const result = await createWorkspace('demo', { mode: 'tui', tool: 'claude', model: 'claude-opus-4-8' })

    // Clients bind the ports (docs/port-forward-tunnel.md); the create only
    // declares them.
    expect(result.forwardedPorts).toEqual([{ containerPort: 3000, hostPort: 3000 }])
    // Init windows and the agent respawn go in one exec. Only windows
    // without hidePane keep remain-on-exit.
    const windows = execOf('new-window')!
    expect(windows).toContain("-n backend 'cd /workspace && pnpm dev:backend'")
    expect(windows).toContain("-n frontend 'cd /workspace && pnpm install && echo '\\''hi'\\'''")
    expect(windows).toContain('set-option -t yaac:backend remain-on-exit on')
    expect(windows).not.toContain('yaac:frontend remain-on-exit on')
    expect(windows).toContain(`claude --permission-mode bypassPermissions --model claude-opus-4-8 --session-id ${result.workspaceId}`)
  })

  it('refuses an init window named after any agent tool, before provisioning', async () => {
    // A retooled spare renames the agent window, so every tool name is
    // taken, not just the one launching.
    for (const name of ['claude', 'codex']) {
      await writeConfig({ initCommands: [{ name, commands: ['echo hi'] }] })
      await expect(createWorkspace('demo', { mode: 'tui', tool: 'claude' })).rejects.toThrow(`"${name}" is reserved`)
    }
    expect(specs).toEqual([])
  })

  it('fails fast, rolling the row back, when origin cannot be fetched', async () => {
    // Nothing listens on this host's 443, so the fetch fails at once.
    vi.stubEnv('YAAC_E2E_SKIP_FETCH', '')
    await recordTestProject('demo', { remoteUrl: 'https://127.0.0.1/o/r.git' })
    await writeConfig({ addAllowedUrls: ['127.0.0.1'] })

    await expect(createWorkspace('demo', { mode: 'tui', workspaceId: 'wt-nofetch' })).rejects.toThrow(/could not fetch from remote/)

    // A bad input is not retried.
    expect(specs).toHaveLength(1)
    await vi.waitFor(async () => {
      expect(await getWorkspaceRow('demo', 'wt-nofetch')).toBeUndefined()
    }, { timeout: 30_000 })
  })

  it('hands an SSH remote the host key it was assigned with, and no GH_TOKEN', async () => {
    await recordTestProject('demo', { remoteUrl: 'git@github.com:o/r.git' })
    const key = await insertGitCredential({ name: 'key', kind: 'ssh', secret: 'c2VlZA==', publicKey: 'ssh-ed25519 AAAA yaac' })
    await setProjectGitCredential('demo', key.id, 'github.com ssh-ed25519 AAAAC3')

    await createWorkspace('demo', { mode: 'tui' })

    // How the key and tunnel reach the workspace is the driver's concern.
    expect(await fs.readFile(specs[0].ssh!.knownHostsFile, 'utf8')).toBe('github.com ssh-ed25519 AAAAC3\n')
    expect(env().filter((e) => e.startsWith('GH_TOKEN='))).toEqual([])
  })

  it('refuses a branch missing from origin, tearing its launch down', async () => {
    await expect(createWorkspace('demo', { mode: 'tui', branch: 'ghost', workspaceId: 'wt-ghost' }))
      .rejects.toThrow(/branch "ghost" not found on origin/)
    expect(specs).toHaveLength(1)
    expect(destroys).toEqual([false])
  })

  it('refuses a taken id before provisioning anything', async () => {
    await createWorkspace('demo', { mode: 'tui', workspaceId: 'wt-taken' })
    await expect(createWorkspace('demo', { mode: 'tui', workspaceId: 'wt-taken' })).rejects.toThrow()
    expect(specs).toHaveLength(1)
  })

  it('fails on its first failed launch and rolls a fresh create back entirely', async () => {
    installDriver({ awaitReady: () => Promise.reject(new Error('pod never became ready')) })

    await expect(createWorkspace('demo', { mode: 'tui', workspaceId: 'wt-fail' })).rejects.toThrow('pod never became ready')

    // One launch, and a fresh create drops its substrate too, since its row
    // is about to go.
    expect(specs).toHaveLength(1)
    expect(destroys).toEqual([false])
    expect(deregistered).toEqual(['wt-fail'])
    // The rollback is not awaited, so it lands after the rejection.
    await vi.waitFor(async () => {
      expect(await getWorkspaceRow('demo', 'wt-fail')).toBeUndefined()
    }, { timeout: 30_000 })
    await expect(fs.access(workspaceDir('demo', 'wt-fail'))).rejects.toThrow()
  })

  describe('resume', () => {
    it('requires a workspace id', async () => {
      await expect(createWorkspace('demo', { mode: 'tui', resume: true })).rejects.toMatchObject({ code: 'VALIDATION' })
    })

    it('reuses the checkout and resumes every restored conversation, codex\'s workspace-id pin anew', async () => {
      await createWorkspace('demo', { mode: 'tui', workspaceId: 'wt-r' })
      await applyWorkspaceEvent({ type: 'workspace-stopped', projectSlug: 'demo', workspaceId: 'wt-r' })
      execs = []
      const progress: string[] = []

      await createWorkspace('demo', {
        mode: 'tui',
        tool: 'codex',
        workspaceId: 'wt-r',
        resume: true,
        resumeAgentSessions: [
          { agentSessionId: 'wt-r', tool: 'codex' },
          { agentSessionId: 'conv-2', tool: 'claude' },
        ],
        onProgress: (m) => progress.push(m),
      })

      expect(progress).toContain(`Reusing existing workspace at ${workspaceDir('demo', 'wt-r')}`)
      // No codex conversation has the workspace-id pin, so `codex resume
      // wt-r` would find nothing and kill the window. claude finds a
      // conversation by its working directory, so it gets `-c`.
      const windows = execOf('respawn-window')!
      expect(windows).toMatch(/respawn-window -k -t yaac:codex 'codex -C \/workspace [^']* --yolo'/)
      expect(windows).not.toContain('resume wt-r')
      expect(windows).toMatch(/new-window -d -t yaac -n claude-2 -c \/workspace '[^']* --resume conv-2'/)
    })

    it('recreates a missing checkout', async () => {
      await createWorkspace('demo', { mode: 'tui', workspaceId: 'wt-gone' })
      await fs.rm(workspaceDir('demo', 'wt-gone'), { recursive: true })

      await createWorkspace('demo', { mode: 'tui', workspaceId: 'wt-gone', resume: true })

      expect(await git(workspaceDir('demo', 'wt-gone'), ['rev-parse', '--abbrev-ref', 'HEAD']))
        .toBe('agent/wt-gone\n')
    })

    it('leaves a failed restart stopped, with its checkout', async () => {
      // The user came back for this workspace, so a failed restart must not
      // erase it.
      await createWorkspace('demo', { mode: 'tui', workspaceId: 'wt-fail' })
      await applyWorkspaceEvent({ type: 'workspace-stopped', projectSlug: 'demo', workspaceId: 'wt-fail' })
      installDriver({ awaitReady: () => Promise.reject(new Error('pod never became ready')) })

      await expect(createWorkspace('demo', { mode: 'tui', workspaceId: 'wt-fail', resume: true })).rejects.toThrow()

      expect((await getWorkspaceRow('demo', 'wt-fail'))?.stoppedAt).toBeInstanceOf(Date)
      await expect(fs.access(workspaceDir('demo', 'wt-fail'))).resolves.toBeUndefined()
      // Its row survives, so the teardown keeps the substrate for the
      // runtime's own sweeps.
      expect(destroys).toEqual([true])
      expect(deregistered).toEqual(['wt-fail'])
    })

    // A restart reuses the row's posture, which another build may have
    // written. Refusing it would strand a checkout, and the driver default
    // could be looser (bypass), so it launches in the nearest mode the tool
    // has that is no looser, else the tool's strictest.
    it('launches a recorded posture the tool lacks in the nearest stricter one', async () => {
      await createWorkspace('demo', { mode: 'tui', workspaceId: 'wt-mode' })
      const resumedAs = async (tool: AgentTool, permissionMode: PermissionMode): Promise<string | undefined> => {
        await createWorkspace('demo', { mode: 'tui', workspaceId: 'wt-mode', resume: true, tool, permissionMode })
        return (await getWorkspaceRow('demo', 'wt-mode'))?.permissionMode
      }
      expect(await resumedAs('claude', 'manual')).toBe('manual')
      expect(await resumedAs('codex', 'plan')).toBe('read-only')
      expect(await resumedAs('claude', 'read-only')).toBe('plan')
      // pi has nothing but bypass.
      expect(await resumedAs('pi', 'plan')).toBe('bypass')
      // A mode this build does not know gets the strictest, never bypass.
      expect(await resumedAs('codex', 'dontAsk' as PermissionMode)).toBe('read-only')
      expect(await resumedAs('claude', 'dontAsk' as PermissionMode)).toBe('plan')
    })
  })

  it('records a prewarmed spare flagged, with no conversation until it is claimed', async () => {
    const { workspaceId } = await createWorkspace('demo', { mode: 'tui', prewarm: true })
    expect(await getWorkspaceRow('demo', workspaceId)).toMatchObject({ spare: true })
    expect(await listWorkspaceAgentSessions('demo', workspaceId)).toEqual([])
    expect(specs[0].prewarm).toBe(true)
  })

  it('leaves a failed spare, checkout and all, to the sweep that collects it on its flag', async () => {
    installDriver({ awaitReady: () => Promise.reject(new Error('pod never became ready')) })
    await expect(createWorkspace('demo', { mode: 'tui', prewarm: true, workspaceId: 'wt-spare' })).rejects.toThrow()
    expect(await getWorkspaceRow('demo', 'wt-spare')).toMatchObject({ spare: true })
    await expect(fs.access(workspaceDir('demo', 'wt-spare'))).resolves.toBeUndefined()
    expect(destroys).toEqual([true])
  })

  it('records the branch it forks from with the row, before anything is provisioned', async () => {
    // A workspace queued after this one defaults to this branch and may be
    // queued mid-provisioning, so it is recorded up front: the requested
    // branch, else the clone's default.
    const rowAtImage = async (workspaceId: string, branch?: string): Promise<WorkspaceRow | undefined> => {
      let row: WorkspaceRow | undefined
      installDriver({
        prepareImage: async () => {
          row = await getWorkspaceRow('demo', workspaceId)
          throw new Error('stop here')
        },
      })
      await expect(createWorkspace('demo', { mode: 'tui', workspaceId, ...(branch !== undefined ? { branch } : {}) }))
        .rejects.toThrow('stop here')
      return row
    }
    expect((await rowAtImage('wt-1', 'dev'))?.baseBranch).toBe('dev')
    expect((await rowAtImage('wt-2'))?.baseBranch).toBe('main')
  })

  it('launches in the time zone clients report, and records it', async () => {
    // A pod would otherwise run in UTC, whatever zone the user is in.
    const before = await createWorkspace('demo', { mode: 'tui' })
    expect(env().filter((e) => e.startsWith('TZ='))).toEqual([])
    expect((await getWorkspaceRow('demo', before.workspaceId))?.timeZone).toBeUndefined()

    await setTimeZone('Asia/Tokyo', false)
    const after = await createWorkspace('demo', { mode: 'tui' })
    expect(env()).toContain('TZ=Asia/Tokyo')
    // Recorded, so a spare claim can tell which zone it launched in.
    expect((await getWorkspaceRow('demo', after.workspaceId))?.timeZone).toBe('Asia/Tokyo')
  })
})
