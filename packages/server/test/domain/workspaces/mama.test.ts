import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { handleFixture, installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'
const P = '83878c91-1713-4890-8e0f-e0fb97a8c47a'

// The DB and group resolution are real. Only the boundaries are faked: the
// runtime (a fake driver reporting `running` and recording execs), the
// create a spawn detaches into, and the teardown a stop detaches into.
vi.mock('#domain/workspaces/create', async (importOriginal) => ({
  ...(await importOriginal<typeof createModule>()),
  createWorkspace: vi.fn(),
}))
vi.mock('#domain/workspaces/cleanup', () => ({
  cleanupWorkspaceDetached: vi.fn(),
  teardownForRestart: vi.fn(),
  tearingDown: () => false,
}))
import type * as createModule from '#domain/workspaces/create'
import { createWorkspace } from '#domain/workspaces/create'
import { cleanupWorkspaceDetached } from '#domain/workspaces/cleanup'
import { closeDb } from '#db/client'
import { createWorkspaceGroup, listWorkspaceGroupRows } from '#db/group-store'
import { getProjectWorkspaceRows, recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'
import { recordProject } from '#db/project-store'
import { listQueuedWorkspaceRows } from '#db/queued-workspace-store'
import { clearAllProvisioningForTests } from '#domain/workspaces/provisioning'
import { _clearListActiveInflightForTests } from '#domain/workspaces/list'
import { listProvisioning, queueWorkspace, runMamaCommand } from '#domain/workspaces'
import type { MamaCaller } from '#domain/workspaces/mama'
import { SPAWN_MAX_IN_FLIGHT_PER_WORKSPACE } from '#domain/workspaces/spawn-policy'
import { recordProjectCreate } from '#db/project-store'
import { FALLBACK_MODELS } from '@yaac/shared/tool-providers'
import { MAX_TITLE_LENGTH } from '@yaac/shared/titles'
import { agentHistoryDir, opencodeCheckpointDir, repoDir, workspaceDir } from '@yaac/shared/project-paths'
import { recordAgentSessions, setActiveAgentSessions } from '#db/agent-session-store'
import { BUILT_IN_USER_ID } from '#db/user-store'
import { applyWorkspaceEvent, deleteToolCredential, getWorkspaceRow, setToolCredential, setWorkspaceGroup } from '#db'
import { cloneRepo } from '#domain/git'
import { _resetWorkspaceStatusStoreForTests, setLiveAgents } from '#runtime/status/status-store'
import { WorkspaceExecError, type RuntimeHandle, type WorkspaceDriver } from '#drivers/contract'
import { git } from '@yaac/test-utils/git'
import { buildPeerReader } from '@yaac/test-utils/peer-reader'
import { setPeerReaderEntry } from '#domain/git/peer-bundle'
import fs from 'node:fs/promises'
import path from 'node:path'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

/** The calling workspace, as the transport identifies it. */
const CALLER = { workspaceId: 'caller-workspace', projectId: PROJ, tool: 'codex' } as const

/** A caller as the transport resolves it: its posture and agent mode from
 *  its row. */
async function callerFor(over: Partial<MamaCaller> = {}): Promise<MamaCaller> {
  const workspaceId = over.workspaceId ?? CALLER.workspaceId
  const row = await getWorkspaceRow(PROJ, workspaceId)
  return {
    ...CALLER,
    workspaceId,
    principal: { kind: 'workspace', workspaceId, userId: BUILT_IN_USER_ID },
    permissionMode: row?.permissionMode ?? 'bypass',
    mode: row?.mode ?? 'tui',
    ...over,
  }
}

let tmpDir: string

/** The workspaces the runtime reports running. */
let running: RuntimeHandle[] = []
/** Commands run in a workspace, as the runtime receives them. */
const exec = vi.fn<WorkspaceDriver['exec']>()

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  running = []
  exec.mockReset()
  installFakeWorkspaceDriver({
    find: (workspaceId) => Promise.resolve(running.find((h) => h.workspaceId === workspaceId)),
    findForTeardown: (workspaceId) => {
      const h = running.find((r) => r.workspaceId === workspaceId)
      return Promise.resolve(h && { projectId: h.projectId, workspaceId: h.workspaceId, unitName: h.jobName })
    },
    list: (projectId) => Promise.resolve(running.filter((h) => !projectId || h.projectId === projectId)),
    exec,
  })
  // The caller's project always exists, since the caller runs in it.
  await recordProject({ id: PROJ, name: 'demo', remoteUrl: 'https://example.com/proj', addedAt: '2026-01-01T00:00:00.000Z' }, BUILT_IN_USER_ID)
  await recordProject({ id: OTHER, name: 'demo', remoteUrl: 'https://example.com/other', addedAt: '2026-01-01T00:00:00.000Z' }, BUILT_IN_USER_ID)
  // Spawns run on the project owner's sign-ins.
  await setToolCredential(BUILT_IN_USER_ID, 'claude', { kind: 'api-key', savedAt: 'x', apiKey: 'k' })
  await setToolCredential(BUILT_IN_USER_ID, 'codex', { kind: 'api-key', savedAt: 'x', apiKey: 'k' })
  clearAllProvisioningForTests()
  _clearListActiveInflightForTests()
  vi.mocked(cleanupWorkspaceDetached).mockReset().mockResolvedValue()
  vi.mocked(createWorkspace).mockReset().mockResolvedValue({
    workspaceId: 'spawned', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui',
  })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** Let a detached create's .then/.finally chains settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const run = async (command: string, body = '', args: Record<string, string> = {}) =>
  runMamaCommand(await callerFor(), { command, args, body })

const output = async (
  command: string,
  body = '',
  args: Record<string, string> = {},
): Promise<string> => {
  const outcome = await run(command, body, args)
  if (!outcome.ok) throw new Error(`expected ok, got: ${outcome.error}`)
  if (!('output' in outcome)) throw new Error('expected text, got a file')
  return outcome.output
}

describe('runMamaCommand', () => {
  it('refuses a command outside the allowlist, naming what is allowed', async () => {
    // This is the one place the allowed commands are enforced for both
    // transports; the proxy relays requests without interpreting them.
    for (const forbidden of ['delete', 'workspace-stop', 'config', '']) {
      const outcome = await run(forbidden)
      expect(outcome.ok, forbidden).toBe(false)
      if (!outcome.ok) expect(outcome.error).toContain('unknown command')
    }
    // The refusal lists the valid commands.
    const outcome = await run('delete')
    if (!outcome.ok) {
      expect(outcome.error).toContain('create')
      expect(outcome.error).toContain('group-move')
    }
  })

  it('refuses an option the command does not take, rather than ignoring it', async () => {
    // A containerless workspace posts straight to the route, bypassing the
    // proxy's shape check. Silently dropping an option would make a request
    // do something other than it said.
    const wrong = await run('rename', 'a title', { group: 'nope' })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.error).toContain("does not take '--group'")

    const none = await run('models', '', { workspace: 'x' })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.error).toContain('takes no options')

    // Prototype names get the same treatment as any other unknown option.
    const proto = await run('list', '', { constructor: 'x' })
    expect(proto.ok).toBe(false)

    // Options a command does take still pass.
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'caller-workspace' })
    expect((await run('create', P, {
      tool: 'claude', model: 'opus', 'permission-mode': 'plan', 'ui-mode': 'acp', branch: 'b', group: 'g', title: 't',
    })).ok).toBe(true)
  })

  it('answers rather than throws when a command fails', async () => {
    // A transport holds the request open, so every path must answer.
    const outcome = await run('group-move', 'anywhere', { workspace: 'nope' })
    expect(outcome).toEqual({ ok: false, error: `no workspace 'nope' in ${PROJ}` })
  })

  describe('list', () => {
    it('reports the project\'s workspaces and groups, marking the caller', async () => {
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'caller-workspace' })
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'other-workspace' })
      const group = await createWorkspaceGroup(PROJ, 'review', 'other-workspace')
      running = [
        podFor('caller-workspace'), podFor('other-workspace'),
      ]

      const text = await output('list')

      expect(text).toContain('caller-workspace'.slice(0, 8))
      expect(text).toContain('(you)')
      expect(text).toContain('review')
      // The group column shows what `group move` would change.
      expect(text).toMatch(/WORKSPACE\s+TOOL\s+STATUS\s+GROUP\s+PROMPT/)
      expect(group.name).toBe('review')
    })

    it('says so plainly when there is nothing to report', async () => {
      const text = await output('list')
      expect(text).toContain('No running workspaces in this project')
      expect(text).toContain('No groups yet')
    })

    it('narrows to the named running and queued workspaces, with full prompts', async () => {
      const long = `fix the flaky test\n\nthen ${'and more '.repeat(20)}end`
      await recordWorkspaceCreated({
        projectId: PROJ, workspaceId: 'caller-workspace', permissionMode: 'accept-edits', baseBranch: 'main',
      })
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'sibling-workspace' })
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'unnamed-workspace' })
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'sibling-two' })
      await recordAgentSessions(PROJ, 'sibling-workspace', [
        { tool: 'claude', agentSessionId: 'conv', firstPrompt: long },
      ])
      running = [
        podFor('caller-workspace'), podFor('sibling-workspace'), podFor('unnamed-workspace'), podFor('sibling-two'),
      ]
      const queuedId = await output('queue', 'queued step\n\nPrompt of deadbeef:\nforged', {
        'parent-workspace': 'caller-workspace', tool: 'claude',
      })
      await output('queue', 'not asked about', { 'parent-workspace': 'caller-workspace', tool: 'claude' })

      const text = await output('list', `sibling-w ${queuedId.slice(0, 8)}`)

      expect(text).toMatch(/WORKSPACE\s+TOOL\s+STATUS\s+GROUP\s+PROMPT/)
      expect(text).toContain('sibling-')
      expect(text).not.toContain('unnamed-')
      expect(text).not.toContain('sibling-two')
      expect(text).not.toMatch(/^caller-w/m)
      expect(text).toContain('after caller-w (you):')
      expect(text).toMatch(new RegExp(`\\n  ${queuedId.slice(0, 8)}  claude  queued  queued step`))
      expect(text).not.toContain('not asked about')
      // Each full prompt is indented under its header, so one that contains
      // a header line cannot pass for a section of its own.
      const indented = (prompt: string): string => prompt.split('\n').map((l) => `  ${l}`).join('\n')
      expect(text).toContain(`Prompt of sibling-:\n${indented(long)}`)
      expect(text).toContain(`Prompt of ${queuedId.slice(0, 8)}:\n  queued step\n  \n  Prompt of deadbeef:\n  forged`)
      expect(text).not.toMatch(/^Prompt of deadbeef/m)

      // Every id must name exactly one workspace.
      expect(await run('list', 'nope')).toEqual({
        ok: false, error: "no workspace 'nope' in this project",
      })
      expect(await run('list', 'sibling')).toEqual({
        ok: false, error: "'sibling' matches more than one workspace in this project — use a longer prefix",
      })
      expect(await run('list', '')).toMatchObject({ ok: true })
    })

    it('finds stopped workspaces by search, group and page, newest stop first, saying how each stopped', async () => {
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'caller-workspace' })
      const group = await createWorkspaceGroup(PROJ, 'parsers', null)
      const stops: Array<[string, string, Parameters<typeof recordWorkspaceStopped>[2]?]> = [
        ['aaaa1111-old', 'port the lexer to rust'],
        ['bbbb2222-mid', 'fix the flaky parser test', { reason: 'oom', detail: 'exit code 137\nOOMKilled' }],
        ['cccc3333-new', 'write the parser docs'],
      ]
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        for (const [i, [id, prompt, cause]] of stops.entries()) {
          vi.setSystemTime(Date.UTC(2026, 9, 20 + i, 12))
          await recordWorkspaceCreated({ projectId: PROJ, workspaceId: id })
          await recordAgentSessions(PROJ, id, [{ tool: 'claude', agentSessionId: `${id}-conv`, firstPrompt: prompt }])
          await recordWorkspaceStopped(PROJ, id, cause)
        }
      } finally {
        vi.useRealTimers()
      }
      await setWorkspaceGroup(PROJ, 'bbbb2222-mid', group.groupId)
      // Another project's stop, and a running workspace, are never listed.
      await recordWorkspaceCreated({ projectId: OTHER, workspaceId: 'dddd4444-foreign' })
      await recordWorkspaceStopped(OTHER, 'dddd4444-foreign')
      running = [podFor('caller-workspace')]

      const all = await output('list', '', { stopped: '1' })
      expect(all).toContain('Stopped workspaces in this project (3 of 3, newest stop first):')
      expect(all).toMatch(/WORKSPACE\s+TOOL\s+STOPPED \(UTC\)\s+HOW\s+GROUP\s+PROMPT/)
      expect(all.indexOf('cccc3333')).toBeLessThan(all.indexOf('bbbb2222'))
      expect(all.indexOf('bbbb2222')).toBeLessThan(all.indexOf('aaaa1111'))
      expect(all).toMatch(/cccc3333\s+claude\s+2026-10-22 12:00\s+stopped\s+write the parser docs/)
      expect(all).toMatch(/bbbb2222\s+claude\s+2026-10-21 12:00\s+oom: exit code 137 OOMKilled\s+parsers\s+fix the flaky/)
      expect(all).not.toContain('dddd4444')
      expect(all).not.toContain('caller-w')
      expect(all).toContain('yaac-mama restart <workspace>')

      const found = await output('list', '', { stopped: '1', search: 'PARSER' })
      expect(found).toContain('matching "PARSER" (2 of 2')
      expect(found).not.toContain('aaaa1111')
      expect(await output('list', '', { stopped: '1', group: 'parsers' })).toMatch(/\(1 of 1[^]*bbbb2222/)
      expect(await output('list', '', { stopped: '1', search: 'nothing like it' }))
        .toBe('No stopped workspaces in this project matching "nothing like it".')

      // A page that has more says how to ask for the next, keeping the search.
      const first = await output('list', '', { stopped: '1', search: 'parser', limit: '1' })
      expect(first).toContain('(1 of 2')
      const next = /^More: yaac-mama list --stopped --search parser --limit 1 --cursor (\S+)$/m.exec(first)?.[1]
      expect(next).toBeDefined()
      const second = await output('list', '', { stopped: '1', search: 'parser', limit: '1', cursor: next! })
      expect(second).toContain('bbbb2222')
      expect(second).not.toContain('cccc3333')
      expect(second).not.toContain('More:')
      expect(await output('list', '', { stopped: '1', search: 'parser', cursor: next! })).not.toContain('More:')

      // The unfiltered listing points at it, and an id shows a stopped one
      // in full.
      const plain = await output('list')
      expect(plain).toContain('3 stopped workspaces: yaac-mama list --stopped')
      const one = await output('list', 'bbbb')
      expect(one).toContain('Stopped workspaces:')
      expect(one).toContain('Prompt of bbbb2222:\n  fix the flaky parser test')
      expect(one).not.toContain('cccc3333')
      expect(one).not.toContain('stopped workspaces: yaac-mama')

      const refusals: Array<[string, Record<string, string>, string]> = [
        ['', { search: 'x' }, "list takes '--search' only with --stopped"],
        ['bbbb', { stopped: '1' }, 'list --stopped takes no workspace ids (list <workspace> shows a stopped one)'],
        ['', { stopped: '1', limit: '0' }, '--limit must be a whole number from 1 to 200'],
        ['', { stopped: '1', limit: '201' }, '--limit must be a whole number from 1 to 200'],
        ['', { stopped: '1', group: 'nope' }, `No such workspace group in ${PROJ}: nope`],
        ['', { stopped: '1', cursor: 'junk' }, 'invalid cursor: junk'],
        ['dddd', {}, "no workspace 'dddd' in this project"],
      ]
      for (const [body, args, error] of refusals) expect(await run('list', body, args)).toEqual({ ok: false, error })
    })

    it('never shows another project\'s workspaces', async () => {
      await recordWorkspaceCreated({ projectId: OTHER, workspaceId: 'elsewhere' })
      await createWorkspaceGroup(OTHER, 'theirs', 'elsewhere')
      running = [podFor('elsewhere', OTHER)]

      const text = await output('list')

      expect(text).not.toContain('elsewhere')
      expect(text).not.toContain('theirs')
    })
  })

  /**
   * A spawn starts detached, under an id it answers with at once. Settings
   * resolution, the provisioning row and the spare decision run for real;
   * only the create itself is stubbed.
   */
  describe('create', () => {
    beforeEach(async () => {
      await recordWorkspaceCreated({
        projectId: PROJ, workspaceId: 'caller-workspace', permissionMode: 'auto', mode: 'tui',
      })
    })

    /** What the detached creates were asked for, once `n` of them have been. */
    const createdWith = async (n = 1): Promise<Array<Parameters<typeof createWorkspace>[1]>> => {
      await vi.waitFor(() => { expect(vi.mocked(createWorkspace).mock.calls.length).toBeGreaterThanOrEqual(n) })
      return vi.mocked(createWorkspace).mock.calls.map((c) => c[1])
    }

    /** Spawn as a caller with the given posture (its row's), returning the
     *  decision or the create it started. */
    const spawn = async (
      args: Record<string, string>,
      caller: Partial<MamaCaller> = {},
    ): Promise<{ ok: false; error: string } | Parameters<typeof createWorkspace>[1]> => {
      vi.mocked(createWorkspace).mockClear()
      const outcome = await runMamaCommand(await callerFor(caller), { command: 'create', args, body: 'do it' })
      if (!outcome.ok) return outcome
      return (await createdWith())[0]
    }

    it('starts a workspace in the caller\'s project under the id it answers with, never a spare\'s', async () => {
      const list = vi.fn(() => Promise.resolve([]))
      installFakeWorkspaceDriver({ list })
      let rowDuringCreate: ReturnType<typeof listProvisioning>[number] | undefined
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      vi.mocked(createWorkspace).mockImplementation(async (_projectId, opts) => {
        opts.onProgress?.('Creating job...')
        rowDuringCreate = listProvisioning()[0]
        await gate
        return { workspaceId: opts.workspaceId, jobName: 'j', forwardedPorts: [], tool: 'codex', mode: 'tui' }
      })

      const output = await run('create', 'write the report')
      // Just the id, so `id=$(yaac-mama create "…")` works.
      if (!output.ok || !('output' in output)) throw new Error('expected an id')
      expect(output.output).toMatch(/^[0-9a-f-]{36}$/)
      // Registered before the answer returns, so the id resolves at once.
      expect(listProvisioning().map((p) => p.workspaceId)).toEqual([output.output])

      const [opts] = await createdWith()
      expect(vi.mocked(createWorkspace).mock.calls[0][0]).toBe(PROJ)
      // The caller's tool, permission mode and UI mode, unless others are
      // requested.
      expect(opts).toMatchObject({
        workspaceId: output.output, initialPrompt: 'write the report', tool: 'codex', permissionMode: 'auto', mode: 'tui',
        model: FALLBACK_MODELS.codex,
      })
      expect(rowDuringCreate).toMatchObject({ workspaceId: output.output, kind: 'create', message: 'Creating job...' })
      release()
      await vi.waitFor(() => { expect(listProvisioning()).toEqual([]) })
      // A claimed spare keeps its own id, so the id handed back would name
      // nothing.
      expect(list).not.toHaveBeenCalled()
    })

    it('keeps a failed row (dismissable) when the detached create rejects', async () => {
      vi.mocked(createWorkspace).mockRejectedValue(new Error('image build exploded'))
      expect((await run('create', 'do it')).ok).toBe(true)
      await vi.waitFor(() => {
        expect(listProvisioning()[0]).toMatchObject({ error: 'image build exploded' })
      })
    })

    it('takes every option the webapp\'s create form has, capped at the caller\'s own posture', async () => {
      expect(await spawn({
        tool: 'claude', model: 'opus', 'permission-mode': 'accept-edits', 'ui-mode': 'acp', branch: 'feature/x',
        title: '  Port   the lexer ',
      })).toMatchObject({
        tool: 'claude', model: 'opus', permissionMode: 'accept-edits', mode: 'acp', branch: 'feature/x',
        title: 'Port the lexer',
      })
      // A provider/model for a non-claude tool, and a named effort, refused
      // when the model lacks it: the create runs detached, so this is the
      // last point the caller can see a refusal.
      expect(await spawn({ model: 'openai/gpt-5.2' })).toMatchObject({ tool: 'codex', model: 'openai/gpt-5.2' })
      expect(await spawn({ tool: 'claude', model: 'claude-opus-4-7', effort: 'max' }))
        .toMatchObject({ model: 'claude-opus-4-7', effort: 'max' })
      expect(await spawn({ tool: 'claude', model: 'claude-opus-4-6', effort: 'xhigh' }))
        .toEqual({ ok: false, error: expect.stringContaining('no "xhigh" effort') as unknown })
      // The UI mode defaults to the caller's.
      expect(await spawn({}, { mode: 'acp' })).toMatchObject({ mode: 'acp' })
    })

    // The caller's tool is reported only when it is one yaac knows.
    it('picks the caller\'s tool, else the project\'s last agent, else claude', async () => {
      expect(await spawn({}, { tool: undefined })).toMatchObject({ tool: 'claude' })
      await recordProjectCreate(PROJ, 'pi', {})
      await setToolCredential(BUILT_IN_USER_ID, 'pi', { kind: 'api-key', provider: 'openrouter', savedAt: 'x', apiKey: 'k' })
      expect(await spawn({}, { tool: undefined, permissionMode: 'bypass' })).toMatchObject({ tool: 'pi' })
    })

    it('refuses a tool the project owner has not signed in to, starting nothing', async () => {
      await deleteToolCredential(BUILT_IN_USER_ID, 'codex')
      expect(await spawn({})).toEqual({
        ok: false, error: expect.stringMatching(/^codex is not signed in for this project's owner/) as string,
      })
      expect(listProvisioning()).toEqual([])
      expect(vi.mocked(createWorkspace)).not.toHaveBeenCalled()
      // Another tool the owner has is fine.
      expect(await spawn({ tool: 'claude' })).toMatchObject({ tool: 'claude' })
    })

    it('inherits the caller\'s posture, stepping down to the most the tool has', async () => {
      await setToolCredential(BUILT_IN_USER_ID, 'opencode', { kind: 'api-key', provider: 'openrouter', savedAt: 'x', apiKey: 'k' })
      await setToolCredential(BUILT_IN_USER_ID, 'pi', { kind: 'api-key', provider: 'openrouter', savedAt: 'x', apiKey: 'k' })
      const posture = async (permissionMode: MamaCaller['permissionMode'], args: Record<string, string> = {}): Promise<unknown> => {
        const result = await spawn(args, { permissionMode })
        return 'ok' in result ? result : result.permissionMode
      }
      expect(await posture('auto')).toBe('auto')
      // A `plan` caller's sibling is `plan`, not the driver's default.
      expect(await posture('plan', { tool: 'claude' })).toBe('plan')
      // opencode has no `auto`, so it inherits the next mode down.
      expect(await posture('auto', { tool: 'opencode' })).toBe('accept-edits')
      // codex has no `manual`, so it steps down to `read-only`, in chat too.
      expect(await posture('manual', { 'ui-mode': 'acp' })).toBe('read-only')
      // Never steps up: pi has nothing below `bypass`, so it is refused.
      expect(await posture('plan', { tool: 'pi' })).toEqual({
        ok: false,
        error: "pi has no permission mode at or below this workspace's own ('plan')",
      })
    })

    it('grants a named posture up to the caller\'s own, and refuses anything else loudly', async () => {
      const at = async (permissionMode: MamaCaller['permissionMode'], asked: string, args: Record<string, string> = { tool: 'claude' }): Promise<unknown> => {
        const result = await spawn({ ...args, 'permission-mode': asked }, { permissionMode })
        return 'ok' in result ? result : result.permissionMode
      }
      expect(await at('accept-edits', 'accept-edits')).toBe('accept-edits')
      expect(await at('accept-edits', 'manual')).toBe('manual')
      expect(await at('manual', 'plan')).toBe('plan')
      // plan and read-only rank equal, so either may be granted under the
      // other.
      expect(await at('plan', 'read-only', {})).toBe('read-only')
      expect(await at('read-only', 'plan')).toBe('plan')

      // Anything more permissive than the caller's mode is refused, never
      // clamped.
      expect(await at('accept-edits', 'auto')).toEqual({
        ok: false,
        error: "permission mode 'auto' is more permissive than this workspace's own ('accept-edits'); "
          + 'a workspace it starts may be granted at most that '
          + '(bypass > auto > accept-edits > manual > plan = read-only)',
      })
      for (const [caller, asked] of [['plan', 'bypass'], ['plan', 'manual'], ['manual', 'accept-edits'], ['auto', 'bypass']] as const) {
        expect(await at(caller, asked), `${caller} → ${asked}`).toMatchObject({ ok: false })
      }
      // Allowed by rank, but the tool lacks that mode.
      expect(await at('auto', 'plan', { 'ui-mode': 'acp' })).toEqual({ ok: false, error: "codex has no 'plan' permission mode" })
      expect(await at('auto', 'manual', {})).toEqual({ ok: false, error: "codex has no 'manual' permission mode" })
      // A caller mode this build does not know (written by another build)
      // cannot be ranked, so nothing is granted.
      const unknown = 'dontAsk' as MamaCaller['permissionMode']
      for (const args of [{ tool: 'claude', 'permission-mode': 'bypass' }, { tool: 'claude' }] as Array<Record<string, string>>) {
        expect(await spawn(args, { permissionMode: unknown })).toEqual({
          ok: false, error: "this workspace's recorded permission mode 'dontAsk' is not one this server knows",
        })
      }
    })

    it('files the new workspace into a group, creating it by name, or reusing one of that name', async () => {
      const opts = await spawn({ group: 'release train' })
      const rows = await listWorkspaceGroupRows(PROJ)
      expect(rows.map((r) => r.name)).toEqual(['release train'])
      // Resolved to an id before the create, so the workspace is filed as
      // soon as its row exists.
      expect(opts).toMatchObject({ groupId: rows[0].groupId })

      expect(await spawn({ group: 'release train' })).toMatchObject({ groupId: rows[0].groupId })
      expect(await listWorkspaceGroupRows(PROJ)).toHaveLength(1)
    })

    it('refuses a malformed option or an empty prompt without creating', async () => {
      const refusals: Array<[Record<string, string>, string]> = [
        [{ tool: 'not-a-tool' }, "invalid tool 'not-a-tool'"],
        [{ model: "opus'; rm -rf /" }, "invalid model 'opus'; rm -rf /'"],
        [{ 'permission-mode': 'yolo' }, "invalid permission mode 'yolo'"],
        [{ effort: 'HIGH; x' }, "invalid effort 'HIGH; x'"],
        [{ 'ui-mode': 'gui' }, "invalid ui mode 'gui'"],
        [{ branch: '  ' }, 'branch must not be empty'],
        [{ title: '  ' }, 'title must not be empty'],
      ]
      for (const [args, error] of refusals) {
        const outcome = await run('create', 'x', args)
        expect(outcome.ok, JSON.stringify(args)).toBe(false)
        if (!outcome.ok) expect(outcome.error).toContain(error)
      }
      expect(await run('create', '   ')).toEqual({ ok: false, error: 'prompt must not be empty' })
      await settle()
      expect(vi.mocked(createWorkspace)).not.toHaveBeenCalled()
    })

    it('caps a caller\'s creates still provisioning, holding the cap against concurrent requests', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      vi.mocked(createWorkspace).mockImplementation(async (_projectId, opts) => {
        await gate
        return { workspaceId: opts.workspaceId, jobName: 'j', forwardedPorts: [], tool: 'codex', mode: 'tui' }
      })
      // A refusal after the cap check (no sign-in for opencode) gives its
      // slot back.
      expect((await run('create', 'x', { tool: 'opencode' })).ok).toBe(false)

      const decisions = await Promise.all(Array.from({ length: 2 * SPAWN_MAX_IN_FLIGHT_PER_WORKSPACE }, () => run('create', 'x')))
      expect(decisions.filter((d) => d.ok)).toHaveLength(SPAWN_MAX_IN_FLIGHT_PER_WORKSPACE)
      expect(decisions.find((d) => !d.ok)).toMatchObject({ error: expect.stringContaining('too many workspaces starting at once') as unknown })

      // Each slot comes back once its create settles.
      release()
      await vi.waitFor(async () => { expect((await run('create', 'x')).ok).toBe(true) })
    })
  })

  it('creates a named group only for a request that goes through', async () => {
    // A refused request (mode limit, unknown parent, a user's entry above the
    // caller) must not change the user's sidebar.
    await recordWorkspaceCreated({
      projectId: PROJ, workspaceId: 'caller-workspace', permissionMode: 'accept-edits', baseBranch: 'main',
    })
    await recordWorkspaceCreated({
      projectId: PROJ, workspaceId: 'loose-sibling', permissionMode: 'bypass', baseBranch: 'main',
    })
    const entry = await queueWorkspace(local, PROJ, {
      parent: 'loose-sibling', prompt: 'user wrote this', tool: 'claude', permissionMode: 'bypass',
    }, 'user')
    const refused: Array<[string, Record<string, string>]> = [
      ['create', { 'permission-mode': 'bypass', group: 'Typo-A' }],
      ['queue', { 'parent-workspace': 'nope', group: 'Typo-B' }],
      ['edit-queued', { queued: entry.id, group: 'Typo-C' }],
    ]
    for (const [command, args] of refused) {
      expect((await run(command, 'x', args)).ok, command).toBe(false)
    }
    expect(await listWorkspaceGroupRows(PROJ)).toEqual([])
  })

  describe('queue', () => {
    beforeEach(async () => {
      await recordWorkspaceCreated({
        projectId: PROJ, workspaceId: 'caller-workspace', permissionMode: 'accept-edits', baseBranch: 'main',
      })
      await recordWorkspaceCreated({
        projectId: PROJ, workspaceId: 'loose-sibling', permissionMode: 'bypass', baseBranch: 'main',
      })
    })

    const ME = { 'parent-workspace': 'caller-workspace' }

    it('queues under the named parent, prints the id, and chains after it', async () => {
      const first = await output('queue', 'step 2', { ...ME, tool: 'claude' })
      expect(first).toMatch(/^[0-9a-f-]{36}$/)
      const second = await output('queue', 'step 3', { 'parent-workspace': first.slice(0, 8) })

      const rows = await listQueuedWorkspaceRows(PROJ)
      expect(rows.find((r) => r.id === first)).toMatchObject({
        parentWorkspaceId: 'caller-workspace', prompt: 'step 2', permissionMode: 'accept-edits', branch: 'main',
      })
      expect(rows.find((r) => r.id === second)).toMatchObject({ parentQueuedId: first, prompt: 'step 3' })
      // Nothing starts until the parent stops.
      await settle()
      expect(vi.mocked(createWorkspace)).not.toHaveBeenCalled()

      // `list` shows the chain, one level deeper per link.
      const listed = await output('list')
      expect(listed).toContain('after caller-w (you):')
      expect(listed).toMatch(new RegExp(`\\n  ${first.slice(0, 8)}  claude  queued  step 2`))
      expect(listed).toMatch(new RegExp(`\\n    ${second.slice(0, 8)}  claude  queued  step 3`))
    })

    it('takes every option create does', async () => {
      const id = await output('queue', 'x', {
        ...ME, tool: 'claude', model: 'opus', 'permission-mode': 'manual', 'ui-mode': 'acp',
        branch: 'feature/x', group: 'follow-ups', title: 'Step two',
      })
      const group = (await listWorkspaceGroupRows(PROJ)).find((g) => g.name === 'follow-ups')
      expect((await listQueuedWorkspaceRows(PROJ)).find((r) => r.id === id)).toMatchObject({
        tool: 'claude', model: 'opus', permissionMode: 'manual', mode: 'acp',
        branch: 'feature/x', groupId: group?.groupId, title: 'Step two',
      })
    })

    it('notes on stderr that a stopped parent must be restarted before its child starts', async () => {
      await recordWorkspaceStopped(PROJ, 'loose-sibling')
      const text = await output('queue', 'x', { 'parent-workspace': 'loose', tool: 'claude' })
      const [id, note] = text.split('\n')
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
      expect(note).toBe('note: loose-si is stopped, so this starts only after it is restarted and stopped again')
    })

    it('never grants more than the caller has, and refuses rather than queueing', async () => {
      // Under a more permissive sibling, the mode is capped at the caller's.
      await output('queue', 'x', { 'parent-workspace': 'loose-sibling', tool: 'claude' })
      expect((await listQueuedWorkspaceRows(PROJ))[0].permissionMode).toBe('accept-edits')

      const refusals: Array<Record<string, string>> = [
        // More permissive than the caller.
        { 'parent-workspace': 'loose-sibling', tool: 'claude', 'permission-mode': 'bypass' },
        // A tool with nothing at or below it.
        { ...ME, tool: 'pi' },
        // A mode the tool lacks.
        { ...ME, tool: 'opencode', 'permission-mode': 'auto' },
        { ...ME, 'permission-mode': 'yolo' },
        { ...ME, 'ui-mode': 'gui' },
        { ...ME, title: '   ' },
        { 'parent-workspace': 'nope' },
        // The parent is never implied.
        {},
      ]
      for (const args of refusals) {
        expect((await run('queue', 'x', args)).ok, JSON.stringify(args)).toBe(false)
      }
      expect(await run('queue', '  ', ME)).toMatchObject({ ok: false })
      expect(await listQueuedWorkspaceRows(PROJ)).toHaveLength(1)
    })
  })

  describe('edit-queued', () => {
    beforeEach(async () => {
      await recordWorkspaceCreated({
        projectId: PROJ, workspaceId: 'caller-workspace', permissionMode: 'accept-edits', baseBranch: 'main',
      })
      await recordWorkspaceCreated({
        projectId: PROJ, workspaceId: 'loose-sibling', permissionMode: 'bypass', baseBranch: 'main',
      })
      await recordWorkspaceCreated({ projectId: OTHER, workspaceId: 'foreign-workspace', baseBranch: 'main' })
    })

    const ME = { 'parent-workspace': 'caller-workspace' }
    const rowOf = async (id: string, projectId = PROJ) =>
      (await listQueuedWorkspaceRows(projectId)).find((r) => r.id === id)

    it('rewrites a queued workspace by short id, keeping what the edit does not name', async () => {
      const id = await output('queue', 'step 2', { ...ME, tool: 'claude', model: 'opus' })
      const text = await output('edit-queued', 'step 2, but also run the linter', { queued: id.slice(0, 8) })
      expect(text).toContain(`Updated queued workspace ${id.slice(0, 8)}`)
      expect(text).toContain('step 2, but also run the linter')
      expect(await rowOf(id)).toMatchObject({
        prompt: 'step 2, but also run the linter', tool: 'claude', model: 'opus',
        permissionMode: 'accept-edits', parentWorkspaceId: 'caller-workspace',
      })

      // Options alone leave the prompt; every create option and the parent
      // can be edited.
      await output('edit-queued', '', {
        queued: id, 'parent-workspace': 'loose-sibling', model: 'sonnet', 'permission-mode': 'plan',
        'ui-mode': 'acp', branch: 'feature/y', group: 'later', title: 'Lint too',
      })
      const group = (await listWorkspaceGroupRows(PROJ)).find((g) => g.name === 'later')
      expect(await rowOf(id)).toMatchObject({
        prompt: 'step 2, but also run the linter', parentWorkspaceId: 'loose-sibling', model: 'sonnet',
        permissionMode: 'plan', mode: 'acp', branch: 'feature/y', groupId: group?.groupId, title: 'Lint too',
      })
    })

    it('holds an entry the user queued above the caller to its ceiling', async () => {
      // The user queued this at `bypass`; an agent in `accept-edits` may not
      // rewrite its prompt, and the mode is not silently lowered.
      const entry = await queueWorkspace(local, PROJ, {
        parent: 'loose-sibling', prompt: 'user wrote this', tool: 'claude', permissionMode: 'bypass',
      }, 'user')
      const refused = await run('edit-queued', 'agent wrote this', { queued: entry.id })
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.error).toContain('more permissive than this workspace')
      expect(await rowOf(entry.id)).toMatchObject({ prompt: 'user wrote this', permissionMode: 'bypass' })

      // Naming a mode at or below the caller's allows the edit.
      await output('edit-queued', 'agent wrote this', { queued: entry.id, 'permission-mode': 'accept-edits' })
      expect(await rowOf(entry.id)).toMatchObject({ prompt: 'agent wrote this', permissionMode: 'accept-edits' })
    })

    it('refuses what it cannot find, a no-op, a cycle, and another project\u2019s entry', async () => {
      const foreign = await queueWorkspace(local, OTHER, {
        parent: 'foreign-workspace', prompt: 'theirs', tool: 'claude',
      }, 'user')
      const id = await output('queue', 'mine', { ...ME, tool: 'claude' })
      const child = await output('queue', 'after mine', { 'parent-workspace': id })
      const refusals: Array<[string, Record<string, string>]> = [
        ['x', {}],
        ['x', { queued: 'nope' }],
        ['x', { queued: foreign.id }],
        ['', { queued: id }],
        ['  ', { queued: id }],
        ['x', { queued: id, 'permission-mode': 'yolo' }],
        ['x', { queued: id, 'parent-workspace': child }],
      ]
      for (const [body, args] of refusals) {
        expect((await run('edit-queued', body, args)).ok, JSON.stringify([body, args])).toBe(false)
      }
      expect(await rowOf(foreign.id, OTHER)).toMatchObject({ prompt: 'theirs' })
      expect(await rowOf(id)).toMatchObject({ prompt: 'mine', parentWorkspaceId: 'caller-workspace' })
    })
  })

  describe('rename', () => {
    beforeEach(async () => {
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'caller-workspace' })
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'sibling-workspace' })
    })

    const titleOf = async (id: string, projectId = PROJ): Promise<string | undefined> =>
      (await getProjectWorkspaceRows(projectId)).get(id)?.title

    it('renames the CALLER when no workspace is named', async () => {
      // With no workspace named, an agent renames itself.
      const text = await output('rename', 'porting the lexer to rust')

      expect(await titleOf('caller-workspace')).toBe('porting the lexer to rust')
      expect(text).toContain('porting the lexer to rust')
    })

    it('is readable back through list, which is the only view an agent has', async () => {
      await output('rename', 'porting the lexer')
      running = [podFor('caller-workspace')]
      _clearListActiveInflightForTests()

      const listed = await output('list')
      expect(listed).toMatch(/WORKSPACE\s+TOOL\s+STATUS\s+GROUP\s+TITLE\s+PROMPT/)
      expect(listed).toContain('porting the lexer')
    })

    it('renames a sibling by short id prefix', async () => {
      await output('rename', 'reviewing the PR', { workspace: 'sibling' })
      expect(await titleOf('sibling-workspace')).toBe('reviewing the PR')
      // The caller is untouched.
      expect(await titleOf('caller-workspace')).toBeUndefined()
    })

    it('reports the stored title, not the one that was sent', async () => {
      // The store normalizes and caps the title, so the reply shows the
      // stored value, not the request.
      const text = await output('rename', `  spaced   out  ${'x'.repeat(200)}`)
      const stored = await titleOf('caller-workspace')
      expect(stored).toHaveLength(120)
      expect(stored?.startsWith('spaced out ')).toBe(true)
      expect(text).toContain(stored!)
    })

    it('refuses an empty title and a workspace it cannot find', async () => {
      expect(await run('rename', '   ')).toEqual({ ok: false, error: 'rename needs a title' })
      expect(await titleOf('caller-workspace')).toBeUndefined()

      const missing = await run('rename', 'x', { workspace: 'nope' })
      expect(missing.ok).toBe(false)
    })

    it('cannot rename another project\u2019s workspace', async () => {
      await recordWorkspaceCreated({ projectId: OTHER, workspaceId: 'foreign-workspace' })
      const outcome = await run('rename', 'mine now', { workspace: 'foreign-workspace' })
      expect(outcome.ok).toBe(false)
      expect(await titleOf('foreign-workspace', OTHER)).toBeUndefined()
    })
  })

  describe('set-base', () => {
    let origin: string
    beforeEach(async () => {
      // A local remote, so a branch pushed after the clone is fetched for real.
      origin = path.join(tmpDir, 'origin')
      await fs.mkdir(origin)
      await git(origin, ['init', '-q', '-b', 'main'])
      await git(origin, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'])
      await recordProject({ id: PROJ, name: 'demo', remoteUrl: origin, addedAt: '2026-01-01T00:00:00.000Z' }, BUILT_IN_USER_ID)
      await cloneRepo(origin, repoDir(PROJ), null)
      await recordWorkspaceCreated({
        projectId: PROJ, workspaceId: 'caller-workspace', permissionMode: 'accept-edits', baseBranch: 'main',
      })
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'sibling-workspace', baseBranch: 'main' })
    })

    const baseOf = async (id: string): Promise<string | undefined> =>
      (await getWorkspaceRow(PROJ, id))?.baseBranch

    it('bases the caller on a just-pushed branch, which what it queues then forks from', async () => {
      await git(origin, ['branch', 'pr/stacked'])
      const text = await output('set-base', ' pr/stacked ')

      expect(await baseOf('caller-workspace')).toBe('pr/stacked')
      expect(await baseOf('sibling-workspace')).toBe('main')
      expect(text).toContain('rebase onto origin/pr/stacked yourself')

      const queued = await output('queue', 'follow-up', { 'parent-workspace': 'caller-workspace', tool: 'claude' })
      expect((await listQueuedWorkspaceRows(PROJ)).find((r) => r.id === queued)?.branch).toBe('pr/stacked')
    })

    it('refuses what is not a branch on origin, fetching at most once per interval', async () => {
      // Past any fetch an earlier test made, which the interval is keyed on.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 3_600_000)
      try {
        // Never a branch name, so refused before any fetch.
        for (const name of ['main~1', 'main:evil', '--upload-pack=x', 'a..b', 'x\ny', 'x/', '@']) {
          expect(await run('set-base', name)).toEqual({ ok: false, error: `"${name}" is not a branch name` })
        }
        const missing = { ok: false, error: 'branch "ghost" not found on origin (pushed just now? retry in 10s)' }
        expect(await run('set-base', 'ghost')).toEqual(missing)
        // Pushed now, but origin was fetched moments ago, so not again yet.
        await git(origin, ['branch', 'ghost'])
        expect(await run('set-base', 'ghost')).toEqual(missing)
        vi.setSystemTime(Date.now() + 10_000)
        await output('set-base', 'ghost')
        expect(await baseOf('caller-workspace')).toBe('ghost')
      } finally {
        vi.useRealTimers()
      }
    })

    it('refuses a blank and another workspace', async () => {
      expect(await run('set-base', '  ')).toEqual({ ok: false, error: 'set-base needs a branch' })
      expect((await run('set-base', 'main', { workspace: 'sibling' })).ok).toBe(false)
      expect(await baseOf('caller-workspace')).toBe('main')
    })
  })

  describe('stop', () => {
    beforeEach(async () => {
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'caller-workspace' })
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'sibling-workspace' })
      running = [
        podFor('caller-workspace'), podFor('sibling-workspace'),
      ]
    })

    it('stops a sibling by short id prefix, keeping what makes it restartable', async () => {
      const text = await output('stop', '', { workspace: 'sibling' })

      // The resolved workspace is the one handed to the teardown.
      expect(vi.mocked(cleanupWorkspaceDetached)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(cleanupWorkspaceDetached).mock.calls[0][0]).toMatchObject({
        workspaceId: 'sibling-workspace',
        projectId: PROJ,
        jobName: 'yaac-sibling-workspace',
      })
      expect(text).toContain('sibling-')
      // The reply must say a stop is reversible, or an agent may treat it as
      // a delete.
      expect(text).toContain('checkout is kept')
      expect(text).toContain('yaac-mama restart sibling-')
    })

    it('stops the CALLER when no workspace is named', async () => {
      // A workspace stopping itself once its job is done.
      await output('stop')

      expect(vi.mocked(cleanupWorkspaceDetached).mock.calls[0][0]).toMatchObject({
        workspaceId: 'caller-workspace',
      })
    })

    it('reports a workspace that is not running as such, not as unknown', async () => {
      // The row exists but there is no unit. The driver's NOT_FOUND points
      // at `yaac workspace list`, which an agent cannot run.
      running = []

      const outcome = await run('stop', '', { workspace: 'sibling' })

      expect(outcome).toEqual({ ok: false, error: 'workspace sibling- is not running' })
      await recordWorkspaceStopped(PROJ, 'sibling-workspace')
      expect(await run('stop', '', { workspace: 'sibling' }))
        .toEqual({ ok: false, error: 'workspace sibling- is already stopped' })
      expect(vi.mocked(cleanupWorkspaceDetached)).not.toHaveBeenCalled()
    })

    it('cannot stop another project\'s workspace', async () => {
      await recordWorkspaceCreated({ projectId: OTHER, workspaceId: 'foreign-workspace' })
      running = [podFor('foreign-workspace', OTHER)]

      const outcome = await run('stop', '', { workspace: 'foreign-workspace' })

      expect(outcome.ok).toBe(false)
      expect(vi.mocked(cleanupWorkspaceDetached)).not.toHaveBeenCalled()
    })

    it('refuses an ambiguous prefix rather than stopping the wrong workspace', async () => {
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'sibling-second' })

      const outcome = await run('stop', '', { workspace: 'sibling' })

      expect(outcome.ok).toBe(false)
      // Distinct from "no such workspace": the caller has the right id and
      // typed too little of it.
      if (!outcome.ok) expect(outcome.error).toContain('use a longer prefix')
      expect(vi.mocked(cleanupWorkspaceDetached)).not.toHaveBeenCalled()
    })
  })

  /**
   * A restart runs for real up to the relaunch, which is stubbed: the
   * provisioning row, the stop record and the history check are the real
   * ones.
   */
  describe('restart', () => {
    beforeEach(async () => {
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'caller-workspace', permissionMode: 'accept-edits' })
      await recordWorkspaceCreated({
        projectId: PROJ, workspaceId: 'sibling-workspace', permissionMode: 'manual', model: 'opus',
      })
      await recordAgentSessions(PROJ, 'sibling-workspace', [
        { tool: 'claude', agentSessionId: 'first-conv' },
        { tool: 'claude', agentSessionId: 'second-conv' },
      ])
      await setActiveAgentSessions(PROJ, 'sibling-workspace', [
        { tool: 'claude', agentSessionId: 'first-conv', paneId: '%3' },
        { tool: 'claude', agentSessionId: 'second-conv', paneId: '%7' },
      ])
      await recordWorkspaceStopped(PROJ, 'sibling-workspace')
      running = [podFor('caller-workspace')]
    })

    it('relaunches a stopped sibling under its id, resuming its conversations in its recorded posture', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      vi.mocked(createWorkspace).mockImplementation(async (_projectId, opts) => {
        await gate
        return { workspaceId: opts.workspaceId, jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui' }
      })
      expect(await output('list')).toContain('1 stopped workspace: yaac-mama list --stopped')

      const text = await output('restart', '', { workspace: 'sibling' })

      expect(text).toContain('Restarting sibling-, resuming its 2 conversations.')
      // Registered before the reply, so the sidebar shows it at once.
      expect(listProvisioning()).toMatchObject([{ workspaceId: 'sibling-workspace', kind: 'restart' }])
      await vi.waitFor(() => { expect(vi.mocked(createWorkspace)).toHaveBeenCalledTimes(1) })
      // It keeps its stop until the relaunch succeeds, but is no longer
      // listed as stopped, so an agent watching does not restart it again.
      expect((await getWorkspaceRow(PROJ, 'sibling-workspace'))?.stoppedAt).toBeInstanceOf(Date)
      expect(await output('list', '', { stopped: '1' })).toBe('No stopped workspaces in this project.')
      expect(await output('list')).not.toContain('stopped workspace')
      release()
      expect(vi.mocked(createWorkspace).mock.calls[0]).toMatchObject([PROJ, {
        workspaceId: 'sibling-workspace',
        tool: 'claude',
        permissionMode: 'manual',
        resume: [{ agentSessionId: 'first-conv', tool: 'claude' }, { agentSessionId: 'second-conv', tool: 'claude' }],
      }])
      await vi.waitFor(async () => {
        expect((await getWorkspaceRow(PROJ, 'sibling-workspace'))?.stoppedAt).toBeUndefined()
      })
      await vi.waitFor(() => { expect(listProvisioning()).toEqual([]) })
    })

    it('refuses what it must not restart, starting nothing', async () => {
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'bypass-workspace', permissionMode: 'bypass' })
      await recordWorkspaceStopped(PROJ, 'bypass-workspace')
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'running-workspace', permissionMode: 'manual' })
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'opencode-workspace', permissionMode: 'manual' })
      await recordAgentSessions(PROJ, 'opencode-workspace', [{ tool: 'opencode', agentSessionId: 'ses_1' }])
      await recordWorkspaceStopped(PROJ, 'opencode-workspace')
      // Its stop is recorded but its unit is back (a restart under way).
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'restarting-workspace', permissionMode: 'manual' })
      await recordWorkspaceStopped(PROJ, 'restarting-workspace')
      // It wrote a transcript the host no longer has.
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'lost-workspace', permissionMode: 'manual' })
      await applyWorkspaceEvent({
        type: 'sessions-launched', projectId: PROJ, workspaceId: 'lost-workspace',
        sessions: [{ tool: 'claude', agentSessionId: 'lost-conv', mode: 'acp', firstPrompt: 'hello' }],
      })
      await recordWorkspaceStopped(PROJ, 'lost-workspace')
      await recordWorkspaceCreated({ projectId: OTHER, workspaceId: 'foreign-workspace', permissionMode: 'manual' })
      await recordWorkspaceStopped(OTHER, 'foreign-workspace')
      // Recorded as `manual`, but pi has only `bypass`, which its
      // conversation would come back in.
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'pi-workspace', permissionMode: 'manual' })
      await recordAgentSessions(PROJ, 'pi-workspace', [
        { tool: 'claude', agentSessionId: 'claude-conv' },
        { tool: 'pi', agentSessionId: 'pi-conv' },
      ])
      await setActiveAgentSessions(PROJ, 'pi-workspace', [
        { tool: 'claude', agentSessionId: 'claude-conv', paneId: '%1' },
        { tool: 'pi', agentSessionId: 'pi-conv', paneId: '%2' },
      ])
      await recordWorkspaceStopped(PROJ, 'pi-workspace')
      running = [podFor('caller-workspace'), podFor('running-workspace'), podFor('restarting-workspace')]
      const refusal = async (workspace: string): Promise<string> => {
        const outcome = await run('restart', '', { workspace })
        if (outcome.ok) throw new Error(`expected a refusal for ${workspace}`)
        return outcome.error
      }

      expect(await refusal('caller')).toBe('restart cannot restart this workspace itself')
      expect(await refusal('running')).toBe('workspace running- is not stopped')
      expect(await refusal('restarting')).toBe('workspace restarti is running; only a stopped one can be restarted')
      expect(await refusal('bypass')).toBe("bypass-w runs in permission mode 'bypass', more than this workspace's own "
        + "('accept-edits'); only one at or below it can be restarted")
      expect(await refusal('pi-work')).toBe("pi-works's pi conversation would come back in permission mode 'bypass', "
        + "the nearest pi has to 'manual', more than this workspace's own ('accept-edits'); only one at or below it "
        + 'can be restarted')
      expect(await refusal('opencode')).toContain('opencode is not signed in for this project\'s owner')
      expect(await refusal('lost')).toContain('the history of Claude Code conversation lost-conv is gone')
      expect(await refusal('foreign-workspace')).toBe(`no workspace 'foreign-workspace' in ${PROJ}`)
      expect(await run('restart')).toEqual({ ok: false, error: 'restart needs a workspace id' })
      expect(listProvisioning()).toEqual([])
      expect(vi.mocked(createWorkspace)).not.toHaveBeenCalled()
    })

    it('counts against the cap a caller\'s creates do', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      vi.mocked(createWorkspace).mockImplementation(async (_projectId, opts) => {
        await gate
        return { workspaceId: opts.workspaceId, jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui' }
      })
      for (let i = 1; i < SPAWN_MAX_IN_FLIGHT_PER_WORKSPACE; i++) expect(await run('create', 'x')).toMatchObject({ ok: true })
      expect((await run('restart', '', { workspace: 'sibling' })).ok).toBe(true)
      expect(await run('create', 'x')).toMatchObject({ ok: false, error: expect.stringContaining('too many workspaces') as unknown })
      release()
      await vi.waitFor(async () => { expect((await run('create', 'x')).ok).toBe(true) })
    })
  })

  describe('send', () => {
    beforeEach(async () => {
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'caller-workspace', permissionMode: 'accept-edits' })
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'sibling-workspace', permissionMode: 'manual' })
      running = [podFor('caller-workspace'), podFor('sibling-workspace')]
      await recordAgentSessions(PROJ, 'sibling-workspace', [
        { tool: 'claude', agentSessionId: 'first-conv' },
        { tool: 'claude', agentSessionId: 'second-conv' },
      ])
      await setActiveAgentSessions(PROJ, 'sibling-workspace', [
        { tool: 'claude', agentSessionId: 'first-conv', paneId: '%3' },
        { tool: 'claude', agentSessionId: 'second-conv', paneId: '%7' },
      ])
      exec.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
      _resetWorkspaceStatusStoreForTests()
    })

    /** The delivery script a command carries, base64-encoded. */
    const scriptOf = (cmd: string): string =>
      Buffer.from(/^sh -c "\$\(printf %s (\S+) \| base64 -d\)"$/.exec(cmd)![1], 'base64').toString('utf8')

    /** The pane the paste script targets, and whether it carries the
     *  message. It runs in the foreground, so the reply can say whether the
     *  message landed. */
    const delivered = (message: string): { jobName: string; pane?: string; carries: boolean } => {
      const [jobName, cmd] = exec.mock.calls.at(-1)!
      const script = scriptOf(cmd)
      return {
        jobName,
        pane: / -t (%\d+)/.exec(script)?.[1],
        carries: script.includes(Buffer.from(message, 'utf8').toString('base64')),
      }
    }

    it('pastes into a sibling\'s first live conversation, or the one named', async () => {
      const text = await output('send', 'rebase onto main\nthen push', { workspace: 'sibling' })

      // Headed with the sender, so the agent knows who is asking.
      expect(delivered('Sent from caller-workspace via yaac-mama:\n\nrebase onto main\nthen push')).toEqual({
        jobName: 'yaac-sibling-workspace', pane: '%3', carries: true,
      })
      expect(text).toContain('Sent to sibling-')
      expect(text).toContain('first-co')

      // Each delivery checks its own conversation for a dialog first.
      expect(scriptOf(exec.mock.calls.at(-1)![1])).toContain('first-conv')

      await output('send', 'and you', { workspace: 'sibling', conversation: 'second' })
      expect(delivered('Sent from caller-workspace via yaac-mama:\n\nand you').pane).toBe('%7')
      expect(scriptOf(exec.mock.calls.at(-1)![1])).toContain('second-conv')
    })

    it('strips control characters before any tool sees them, pi\'s editor-free path included', async () => {
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'pi-workspace', permissionMode: 'manual' })
      await recordAgentSessions(PROJ, 'pi-workspace', [{ tool: 'pi', agentSessionId: 'pi-conv' }])
      await setActiveAgentSessions(PROJ, 'pi-workspace', [{ tool: 'pi', agentSessionId: 'pi-conv', paneId: '%5' }])
      running = [podFor('caller-workspace'), podFor('pi-workspace')]

      await output('send', 'look\x1b]52;c;cGF5bG9hZA==\x07 here\x1b[6n', { workspace: 'pi-workspace' })

      // An OSC clipboard write and a cursor query, rendered by pi's TUI,
      // would reach the terminal; only their printable remains arrive.
      expect(delivered('Sent from caller-workspace via yaac-mama:\n\nlook]52;c;cGF5bG9hZA== here[6n'))
        .toMatchObject({ pane: '%5', carries: true })
    })

    it('reports a message the agent could not take as not delivered', async () => {
      exec.mockRejectedValue(new WorkspaceExecError('paste', 1, '', 'prompt never appeared'))

      const outcome = await run('send', 'go', { workspace: 'sibling' })

      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error).toMatch(/^not delivered to sibling-'s claude conversation first-co: .*nothing was submitted/)

      // The paste script found a dialog up, so it typed nothing.
      exec.mockRejectedValue(new WorkspaceExecError('paste', 3, '', 'showing a prompt'))
      const asking = await run('send', 'go', { workspace: 'sibling' })
      expect(asking.ok === false && asking.error).toContain('nothing was typed')
    })

    it('delivers one message at a time per sender and per conversation', async () => {
      let release!: () => void
      exec.mockReturnValueOnce(new Promise((resolve) => {
        release = () => resolve({ stdout: '', stderr: '' })
      }))
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'third-workspace', permissionMode: 'manual' })
      running = [
        podFor('caller-workspace'), podFor('sibling-workspace'), podFor('third-workspace'),
      ]
      const third = await callerFor({ workspaceId: 'third-workspace' })

      const first = run('send', 'one', { workspace: 'sibling' })
      await vi.waitFor(() => { expect(exec).toHaveBeenCalledTimes(1) })
      const again = await run('send', 'two', { workspace: 'sibling', conversation: 'second' })
      const other = await runMamaCommand(third, { command: 'send', args: { workspace: 'sibling' }, body: 'three' })
      release()

      expect(again.ok === false && again.error).toContain('previous send is still being delivered')
      expect(other.ok === false && other.error).toContain('another message to sibling-')
      expect((await first).ok).toBe(true)
      expect(exec).toHaveBeenCalledTimes(1)
      // Both free again once it lands.
      expect((await run('send', 'two', { workspace: 'sibling' })).ok).toBe(true)
    })

    it('refuses a target it must not or cannot message, sending nothing', async () => {
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'bypass-workspace', permissionMode: 'bypass' })
      await recordAgentSessions(PROJ, 'bypass-workspace', [{ tool: 'claude', agentSessionId: 'bypass-conv' }])
      await setActiveAgentSessions(PROJ, 'bypass-workspace', [{ tool: 'claude', agentSessionId: 'bypass-conv', paneId: '%1' }])
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'stopped-workspace', permissionMode: 'plan' })
      await recordWorkspaceCreated({ projectId: OTHER, workspaceId: 'foreign-workspace', permissionMode: 'plan' })
      running = [
        podFor('caller-workspace'), podFor('sibling-workspace'), podFor('bypass-workspace'),
        podFor('foreign-workspace', OTHER),
      ]
      const refusal = async (body: string, args: Record<string, string>): Promise<string> => {
        const outcome = await run('send', body, args)
        if (outcome.ok) throw new Error(`expected a refusal for ${JSON.stringify(args)}`)
        return outcome.error
      }

      // A message is as good as a prompt, so the caller's posture caps it:
      // the row's, and the conversation's own when it reported one.
      expect(await refusal('go', { workspace: 'bypass' })).toContain('more than this workspace\'s own')
      setLiveAgents(PROJ, 'sibling-workspace', [
        { handle: '%3', tool: 'claude', agentSessionId: 'first-conv', reportedMode: 'bypassPermissions' },
        { handle: '%7', tool: 'claude', agentSessionId: 'second-conv', reportedMode: 'mystery' },
      ])
      expect(await refusal('go', { workspace: 'sibling' })).toContain('runs in permission mode \'bypass\'')
      expect(await refusal('go', { workspace: 'sibling', conversation: 'second' })).toContain('cannot tell which permission mode')
      _resetWorkspaceStatusStoreForTests()

      expect(await refusal('go', { workspace: 'caller-workspace' })).toContain('itself')
      expect(await refusal('go', { workspace: 'stopped' })).toBe('workspace stopped- is not running')
      await recordWorkspaceStopped(PROJ, 'stopped-workspace')
      expect(await refusal('go', { workspace: 'stopped' }))
        .toBe('workspace stopped- is stopped; restart it with yaac-mama restart stopped-, then send once it is running')
      expect(await refusal('go', { workspace: 'foreign-workspace' })).toContain('no workspace')
      expect(await refusal('go', { workspace: 'sibling', conversation: 'nope' })).toContain('no running conversation')
      expect(await refusal('  ', { workspace: 'sibling' })).toContain('needs a message')
      await setActiveAgentSessions(PROJ, 'sibling-workspace', [])
      expect(await refusal('go', { workspace: 'sibling' })).toContain('has no running conversation yet')
      expect(exec).not.toHaveBeenCalled()
    })
  })

  describe('group-create', () => {
    it('makes an empty group the caller can then file workspaces into', async () => {
      const text = await output('group-create', 'release train')
      expect(text).toContain('release train')

      const rows = await listWorkspaceGroupRows(PROJ)
      expect(rows).toHaveLength(1)
      // Pinned, or an empty group would not be listed anywhere.
      expect(rows[0]).toMatchObject({ name: 'release train', pinned: true })
    })

    it('is idempotent, so an agent can name a group without checking first', async () => {
      await output('group-create', 'review')
      await output('group-create', 'review')
      expect(await listWorkspaceGroupRows(PROJ)).toHaveLength(1)
    })

    it('reports the name as stored, not as typed', async () => {
      // The store collapses whitespace, so the reply shows the stored name,
      // and the same input must reach the same group.
      const text = await output('group-create', 'release   train')
      expect(text).toContain('"release train"')

      await output('group-create', ' release train ')
      expect(await listWorkspaceGroupRows(PROJ)).toHaveLength(1)
    })

    it('refuses a name longer than the store keeps', async () => {
      // A name accepted then truncated would let two long names sharing a
      // prefix resolve to one group.
      const outcome = await run('group-create', 'x'.repeat(MAX_TITLE_LENGTH + 1))
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error).toContain(`exceeds ${MAX_TITLE_LENGTH}`)
      expect(await listWorkspaceGroupRows(PROJ)).toEqual([])
    })

    it('refuses a blank name', async () => {
      const outcome = await run('group-create', '   ')
      expect(outcome).toEqual({ ok: false, error: 'group name must not be empty' })
      expect(await listWorkspaceGroupRows(PROJ)).toEqual([])
    })
  })

  describe('group-move', () => {
    beforeEach(async () => {
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'aaaabbbb-1111-2222' })
    })

    const groupOf = async (id: string, projectId = PROJ): Promise<string | undefined> =>
      (await getProjectWorkspaceRows(projectId)).get(id)?.groupId

    it('files a workspace by short id prefix, creating the group', async () => {
      const text = await output('group-move', 'release', { workspace: 'aaaabbbb' })
      expect(text).toContain('into "release"')

      const rows = await listWorkspaceGroupRows(PROJ)
      expect(await groupOf('aaaabbbb-1111-2222')).toBe(rows[0].groupId)
    })

    it('reports the group’s name when it was addressed by id', async () => {
      // The ambiguity error tells agents to pass an id, so the reply must
      // name the group, not echo a uuid.
      const group = await createWorkspaceGroup(PROJ, 'release train', null)

      const text = await output('group-move', group.groupId, { workspace: 'aaaabbbb' })

      expect(text).toContain('into "release train"')
      expect(text).not.toContain(group.groupId)
    })

    it('returns a workspace to the default list on "--"', async () => {
      await output('group-move', 'release', { workspace: 'aaaabbbb' })
      const text = await output('group-move', '--', { workspace: 'aaaabbbb' })

      expect(text).toContain('out of its group')
      expect(await groupOf('aaaabbbb-1111-2222')).toBeUndefined()
      // The group itself survives its last member leaving.
      expect(await listWorkspaceGroupRows(PROJ)).toHaveLength(1)
    })

    it('cannot move another project\'s workspace', async () => {
      await recordWorkspaceCreated({ projectId: OTHER, workspaceId: 'foreign-workspace' })

      const outcome = await run('group-move', 'release', { workspace: 'foreign-workspace' })

      expect(outcome.ok).toBe(false)
      expect(await groupOf('foreign-workspace', OTHER)).toBeUndefined()
    })

    it('refuses an ambiguous prefix rather than moving the wrong workspace', async () => {
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'aaaabbbb-3333-4444' })
      const outcome = await run('group-move', 'release', { workspace: 'aaaabbbb' })
      expect(outcome.ok).toBe(false)
      // The message asks for a longer prefix rather than sending the caller
      // back to `list`.
      if (!outcome.ok) expect(outcome.error).toContain('use a longer prefix')
    })

    it('needs a workspace to move', async () => {
      const outcome = await run('group-move', 'release')
      expect(outcome).toEqual({ ok: false, error: 'group move needs a workspace id' })
    })
  })

  describe('fetch', () => {
    beforeAll(async () => { setPeerReaderEntry(await buildPeerReader()) })

    it('bundles a stopped sibling\'s branches by short id, and nothing of another project\'s', async () => {
      // A stopped workspace: a row and a checkout, no unit.
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'sibling-workspace' })
      await recordWorkspaceCreated({ projectId: OTHER, workspaceId: 'foreign-workspace' })
      const checkout = workspaceDir(PROJ, 'sibling-workspace')
      await fs.mkdir(checkout, { recursive: true })
      await git(checkout, ['init', '-q', '-b', 'agent/sibling'])
      await fs.writeFile(path.join(checkout, 'notes.txt'), 'work\n')
      await git(checkout, ['add', '.'])
      await git(checkout, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-qm', 'work'])
      const tip = (await git(checkout, ['rev-parse', 'HEAD'])).trim()

      const outcome = await run('fetch', '', { workspace: 'sibling' })
      if (!outcome.ok || !('body' in outcome)) throw new Error(`expected a bundle, got ${JSON.stringify(outcome)}`)
      expect(outcome.workspaceId).toBe('sibling-workspace')
      expect(outcome.contentType).toBe('application/x-git-bundle')
      expect(Buffer.from(await new Response(outcome.body).arrayBuffer()).toString('latin1')).toContain(`${tip} refs/heads/agent/sibling\n${tip} HEAD\n`)

      expect(await run('fetch', '', { workspace: 'foreign-workspace' }))
        .toEqual({ ok: false, error: `no workspace 'foreign-workspace' in ${PROJ}` })
      expect(await run('fetch')).toEqual({ ok: false, error: 'fetch needs a workspace id' })
    })
  })

  describe('history', () => {
    /** The file an outcome carries. */
    const file = async (outcome: Awaited<ReturnType<typeof run>>): Promise<Buffer> => {
      if (!outcome.ok || !('body' in outcome)) throw new Error(`expected a file, got ${JSON.stringify(outcome)}`)
      return Buffer.from(await new Response(outcome.body).arrayBuffer())
    }

    it('lists a stopped sibling\'s conversations, prints one\'s transcripts, and hands out each file', async () => {
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'sibling-workspace' })
      await recordWorkspaceCreated({ projectId: OTHER, workspaceId: 'foreign-workspace' })
      await recordAgentSessions(PROJ, 'sibling-workspace', [
        { tool: 'claude', agentSessionId: 'claude-conv', firstPrompt: 'write the report' },
        { tool: 'opencode', agentSessionId: 'opencode-conv' },
      ])
      const conversations = path.join(agentHistoryDir(PROJ, 'sibling-workspace', 'claude'), '-workspace')
      await fs.mkdir(path.join(conversations, 'claude-conv', 'subagents'), { recursive: true })
      // The main transcript lacks its final newline, as a live one can.
      await fs.writeFile(path.join(conversations, 'claude-conv.jsonl'), '{"main":1}')
      await fs.writeFile(path.join(conversations, 'claude-conv', 'subagents', 'agent-a.jsonl'), '{"sub":1}\n')
      await fs.mkdir(opencodeCheckpointDir(PROJ, 'sibling-workspace'), { recursive: true })
      await fs.writeFile(path.join(opencodeCheckpointDir(PROJ, 'sibling-workspace'), 'opencode.db'), 'SQLite')

      const listing = await output('history', '', { workspace: 'sibling' })
      expect(listing).toContain('Conversations of sibling-')
      expect(listing).toMatch(/claude-conv\s+claude\s+tui\s+yes\s+.*\s2\s+20 B\s+write the report/)
      expect(listing).toMatch(/opencode-conv\s+opencode\s+tui\s+yes\s+.*\s1\s+6 B/)

      // A prefix names a conversation; its transcripts print main first.
      expect((await file(await run('history', '', { workspace: 'sibling', conversation: 'claude' }))).toString())
        .toBe('{"main":1}\n{"sub":1}\n')

      // Every file is named under its conversation, and handed out as is.
      expect(await output('history', '', { workspace: 'sibling', files: '1' }))
        .toBe('claude-conv/claude-conv.jsonl\nclaude-conv/claude-conv/subagents/agent-a.jsonl\nopencode-conv/opencode.db')
      expect((await file(await run('history', '', {
        workspace: 'sibling', conversation: 'claude-conv', file: 'claude-conv.jsonl',
      }))).toString()).toBe('{"main":1}')
      expect(await run('history', '', { workspace: 'sibling', conversation: 'claude-conv', file: '../secret' }))
        .toEqual({ ok: false, error: 'claude-conv has no file \'../secret\'' })

      // A file past the cap is never sent: a sparse one costs the workspace
      // nothing, while the caller would write every byte.
      const huge = path.join(conversations, 'claude-conv', 'subagents', 'agent-huge.jsonl')
      await fs.writeFile(huge, '')
      await fs.truncate(huge, 300 * 1024 * 1024)
      const tooLarge = 'agent-huge.jsonl is 300.0 MB, past the 256.0 MB a file is handed out at'
      expect(await output('history', '', { workspace: 'sibling' })).toContain('Files over 256.0 MB are not handed out')
      expect(await output('history', '', { workspace: 'sibling', conversation: 'claude-conv', files: '1' }))
        .toContain('# skipped claude-conv/claude-conv/subagents/agent-huge.jsonl: 300.0 MB, past the 256.0 MB')
      expect(await run('history', '', { workspace: 'sibling', conversation: 'claude-conv' }))
        .toEqual({ ok: false, error: `claude-conv/subagents/${tooLarge}` })
      expect(await run('history', '', {
        workspace: 'sibling', conversation: 'claude-conv', file: 'claude-conv/subagents/agent-huge.jsonl',
      })).toEqual({ ok: false, error: `claude-conv/subagents/${tooLarge}` })

      // An opencode conversation's history is the workspace's database, named
      // as such for the script to convert, with the conversation's full id.
      const opencode = await run('history', '', { workspace: 'sibling', conversation: 'opencode' })
      expect(opencode).toMatchObject({ contentType: 'application/vnd.sqlite3', conversationId: 'opencode-conv' })
      expect((await file(opencode)).toString()).toBe('SQLite')
      expect(await run('history', '', { workspace: 'sibling', conversation: 'nope' }))
        .toEqual({ ok: false, error: 'no conversation \'nope\' in sibling- (see: yaac-mama history sibling-)' })
      expect(await run('history', '', { workspace: 'foreign-workspace' }))
        .toEqual({ ok: false, error: `no workspace 'foreign-workspace' in ${PROJ}` })
      expect(await run('history')).toEqual({ ok: false, error: 'history needs a workspace id' })
    })
  })

  describe('models', () => {
    it('reports every tool, and which the project owner has signed in to', async () => {
      // Only claude and codex are seeded.
      const text = await output('models')
      expect(text).toMatch(/^codex\s+api-key$/m)
      expect(text).toMatch(/^pi\s+not configured/m)
      expect(text).toContain('claude')
      expect(text).toContain('codex')
      expect(text).toContain('opencode')
      expect(text).toContain('pi')
      expect(text).toContain('not configured')
      // It names the caller's own tool, the known-good default.
      expect(text).toContain('codex')
      // Each model's effort levels follow it, its default starred.
      expect(text).toContain('claude-opus-4-7 (Opus 4.7) [effort low medium high xhigh* max]')
    })
  })
})

function podFor(workspaceId: string, projectId = PROJ): RuntimeHandle {
  return handleFixture({
    jobName: `yaac-${workspaceId}`,
    workspaceId,
    projectId,
    tool: 'claude',
    createdAtMs: 1_760_000_000_000,
  })
}
