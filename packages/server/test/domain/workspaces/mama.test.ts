import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { installRealWorkspaceDriver } from '@yaac/test-utils/real-driver'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

// The DB and group resolution are real. Only process boundaries are mocked:
// pod listing, the create a spawn detaches into, and the teardown a stop
// detaches into.
vi.mock('#drivers/k8s/substrate/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listWorkspacePods: vi.fn().mockResolvedValue([]),
    listWorkspaceJobs: vi.fn().mockResolvedValue([]),
  }
})
vi.mock('#domain/workspaces/create', async (importOriginal) => ({
  ...(await importOriginal<typeof createModule>()),
  createWorkspace: vi.fn(),
}))
vi.mock('#domain/workspaces/cleanup', () => ({ cleanupWorkspaceDetached: vi.fn() }))
vi.mock('#drivers/k8s/substrate/stream-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof streamRelayModule>()),
  podExec: vi.fn(),
}))

import { listWorkspacePods } from '#drivers/k8s/substrate/pods'
import type * as podsModule from '#drivers/k8s/substrate/pods'
import type * as streamRelayModule from '#drivers/k8s/substrate/stream-relay'
import { podExec } from '#drivers/k8s/substrate/stream-relay'
import type * as createModule from '#domain/workspaces/create'
import { createWorkspace } from '#domain/workspaces/create'
import { cleanupWorkspaceDetached } from '#domain/workspaces/cleanup'
import { closeDb } from '#db/client'
import { createWorkspaceGroup, listWorkspaceGroupRows } from '#db/group-store'
import { getProjectWorkspaceRows, recordWorkspaceCreated } from '#db/workspace-store'
import { recordProject } from '#db/project-store'
import { listQueuedWorkspaceRows } from '#db/queued-workspace-store'
import { clearAllProvisioningForTests } from '#domain/workspaces/provisioning'
import { _clearListActiveInflightForTests } from '#domain/workspaces/list'
import { runMamaCommand, type MamaCaller } from '#domain/workspaces/mama'
import { queueWorkspace } from '#domain/workspaces/queued-workspaces'
import { MAX_TITLE_LENGTH } from '@yaac/shared/titles'
import { agentHistoryDir, opencodeCheckpointDir, workspaceDir } from '@yaac/shared/project-paths'
import { recordAgentSessions, setActiveAgentSessions } from '#db/agent-session-store'
import { _resetWorkspaceStatusStoreForTests, setLiveAgents } from '#runtime/status/status-store'
import { WorkspaceExecError } from '#drivers/contract'
import { git } from '@yaac/test-utils/git'
import { buildPeerReader } from '@yaac/test-utils/peer-reader'
import { setPeerReaderEntry } from '#domain/git/peer-bundle'
import fs from 'node:fs/promises'
import path from 'node:path'

const CALLER: MamaCaller = {
  workspaceId: 'caller-workspace',
  projectSlug: 'proj',
  tool: 'codex',
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  installRealWorkspaceDriver()
  // The caller's project always exists, since the caller runs in it.
  await recordProject({ slug: 'proj', remoteUrl: 'https://example.com/proj', addedAt: '2026-01-01T00:00:00.000Z' })
  await recordProject({ slug: 'other', remoteUrl: 'https://example.com/other', addedAt: '2026-01-01T00:00:00.000Z' })
  clearAllProvisioningForTests()
  _clearListActiveInflightForTests()
  vi.mocked(listWorkspacePods).mockResolvedValue([])
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

/** Wait for the detached spawn to reach the mocked create, which takes more
 *  than a tick. */
const created = (): Promise<void> =>
  vi.waitFor(() => { expect(vi.mocked(createWorkspace)).toHaveBeenCalled() })

const run = (command: string, body = '', args: Record<string, string> = {}) =>
  runMamaCommand(CALLER, { command, args, body })

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
    for (const forbidden of ['delete', 'restart', 'workspace-stop', 'config', '']) {
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

    const none = await run('list', '', { workspace: 'x' })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.error).toContain('takes no options')

    // Prototype names get the same treatment as any other unknown option.
    const proto = await run('list', '', { constructor: 'x' })
    expect(proto.ok).toBe(false)

    // Options a command does take still pass.
    await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'caller-workspace' })
    expect((await run('create', 'p', {
      tool: 'claude', model: 'opus', 'permission-mode': 'plan', 'ui-mode': 'acp', branch: 'b', group: 'g', title: 't',
    })).ok).toBe(true)
  })

  it('answers rather than throws when a command fails', async () => {
    // A transport holds the request open, so every path must answer.
    const outcome = await run('group-move', 'anywhere', { workspace: 'nope' })
    expect(outcome).toEqual({ ok: false, error: "no workspace 'nope' in proj" })
  })

  describe('list', () => {
    it('reports the project\'s workspaces and groups, marking the caller', async () => {
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'caller-workspace' })
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'other-workspace' })
      const group = await createWorkspaceGroup('proj', 'review', 'other-workspace')
      vi.mocked(listWorkspacePods).mockResolvedValue([
        podFor('caller-workspace'), podFor('other-workspace'),
      ])

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
      expect(text).toContain('No running workspaces in proj')
      expect(text).toContain('No groups yet')
    })

    it('narrows to the named running and queued workspaces, with full prompts', async () => {
      const long = `fix the flaky test\n\nthen ${'and more '.repeat(20)}end`
      await recordWorkspaceCreated({
        projectSlug: 'proj', workspaceId: 'caller-workspace', permissionMode: 'accept-edits', baseBranch: 'main',
      })
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'sibling-workspace' })
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'unnamed-workspace' })
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'sibling-two' })
      await recordAgentSessions('proj', 'sibling-workspace', [
        { tool: 'claude', agentSessionId: 'conv', firstPrompt: long },
      ])
      vi.mocked(listWorkspacePods).mockResolvedValue([
        podFor('caller-workspace'), podFor('sibling-workspace'), podFor('unnamed-workspace'), podFor('sibling-two'),
      ])
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
        ok: false, error: "no running or queued workspace 'nope' in proj",
      })
      expect(await run('list', 'sibling')).toEqual({
        ok: false, error: "'sibling' matches more than one running or queued workspace in proj — use a longer prefix",
      })
      expect(await run('list', '')).toMatchObject({ ok: true })
    })

    it('never shows another project\'s workspaces', async () => {
      await recordWorkspaceCreated({ projectSlug: 'other', workspaceId: 'elsewhere' })
      await createWorkspaceGroup('other', 'theirs', 'elsewhere')
      vi.mocked(listWorkspacePods).mockResolvedValue([podFor('elsewhere', 'other')])

      const text = await output('list')

      expect(text).not.toContain('elsewhere')
      expect(text).not.toContain('theirs')
    })
  })

  describe('create', () => {
    beforeEach(async () => {
      await recordWorkspaceCreated({
        projectSlug: 'proj', workspaceId: 'caller-workspace', permissionMode: 'auto', mode: 'tui',
      })
    })

    it('starts a workspace in the caller\'s project and returns just the id', async () => {
      const outcome = await run('create', 'write the report')
      expect(outcome.ok).toBe(true)
      // Just the id, so `id=$(yaac-mama create "…")` works.
      if (outcome.ok && 'output' in outcome) expect(outcome.output).toMatch(/^[0-9a-f-]{36}$/)
      await created()

      expect(vi.mocked(createWorkspace)).toHaveBeenCalledTimes(1)
      const [slug, opts] = vi.mocked(createWorkspace).mock.calls[0]
      expect(slug).toBe('proj')
      // The caller's tool, permission mode and UI mode, unless others are
      // requested.
      expect(opts).toMatchObject({ initialPrompt: 'write the report', tool: 'codex', permissionMode: 'auto', mode: 'tui' })
    })

    it('takes every option the webapp\'s create form has, capped at the caller\'s own posture', async () => {
      expect((await run('create', 'do it', {
        tool: 'claude', model: 'opus', 'permission-mode': 'accept-edits', 'ui-mode': 'acp', branch: 'feature/x',
        title: '  Port   the lexer ',
      })).ok).toBe(true)
      await created()
      expect(vi.mocked(createWorkspace).mock.calls[0][1]).toMatchObject({
        tool: 'claude', model: 'opus', permissionMode: 'accept-edits', mode: 'acp', branch: 'feature/x',
        title: 'Port the lexer',
      })

      // The limit comes from the caller's recorded row, not the request.
      const above = await run('create', 'do it', { 'permission-mode': 'bypass' })
      expect(above.ok).toBe(false)
      if (!above.ok) expect(above.error).toContain("more permissive than this workspace's own ('auto')")
      await settle()
      expect(vi.mocked(createWorkspace)).toHaveBeenCalledTimes(1)
    })

    it('refuses a caller with no recorded posture to cap the spawn at', async () => {
      const outcome = await runMamaCommand({ ...CALLER, workspaceId: 'unrecorded' }, {
        command: 'create', args: {}, body: 'do it',
      })
      expect(outcome).toEqual({ ok: false, error: 'this workspace has no recorded permission mode' })
    })

    it('files the new workspace into a group, creating it by name', async () => {
      const outcome = await run('create', 'do it', { group: 'release train' })
      expect(outcome.ok).toBe(true)
      await created()

      const rows = await listWorkspaceGroupRows('proj')
      expect(rows.map((r) => r.name)).toEqual(['release train'])
      // The group is resolved to an id before the create, so the workspace is
      // filed as soon as its row exists.
      const [, opts] = vi.mocked(createWorkspace).mock.calls[0]
      expect(opts.groupId).toBe(rows[0].groupId)
    })

    it('reuses an existing group rather than making a second of the same name', async () => {
      const existing = await createWorkspaceGroup('proj', 'review', null)
      await run('create', 'do it', { group: 'review' })
      await created()

      expect(await listWorkspaceGroupRows('proj')).toHaveLength(1)
      expect(vi.mocked(createWorkspace).mock.calls[0][1].groupId).toBe(existing.groupId)
    })

    it('relays the policy\'s refusal instead of starting anything', async () => {
      const outcome = await run('create', '   ')
      expect(outcome).toEqual({ ok: false, error: 'prompt must not be empty' })
      await settle()
      expect(vi.mocked(createWorkspace)).not.toHaveBeenCalled()
    })

    it('refuses a malformed option without creating', async () => {
      const refusals: Array<[Record<string, string>, string]> = [
        [{ tool: 'not-a-tool' }, "invalid tool 'not-a-tool'"],
        [{ model: "opus'; rm -rf /" }, "invalid model 'opus'; rm -rf /'"],
        [{ 'permission-mode': 'yolo' }, "invalid permission mode 'yolo'"],
        [{ 'ui-mode': 'gui' }, "invalid ui mode 'gui'"],
        [{ branch: '  ' }, 'branch must not be empty'],
        [{ title: '  ' }, 'title must not be empty'],
      ]
      for (const [args, error] of refusals) {
        const outcome = await run('create', 'x', args)
        expect(outcome.ok, JSON.stringify(args)).toBe(false)
        if (!outcome.ok) expect(outcome.error).toContain(error)
      }
      await settle()
      expect(vi.mocked(createWorkspace)).not.toHaveBeenCalled()
    })
  })

  it('creates a named group only for a request that goes through', async () => {
    // A refused request (mode limit, unknown parent, a user's entry above the
    // caller) must not change the user's sidebar.
    await recordWorkspaceCreated({
      projectSlug: 'proj', workspaceId: 'caller-workspace', permissionMode: 'accept-edits', baseBranch: 'main',
    })
    await recordWorkspaceCreated({
      projectSlug: 'proj', workspaceId: 'loose-sibling', permissionMode: 'bypass', baseBranch: 'main',
    })
    const entry = await queueWorkspace('proj', {
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
    expect(await listWorkspaceGroupRows('proj')).toEqual([])
  })

  describe('queue', () => {
    beforeEach(async () => {
      await recordWorkspaceCreated({
        projectSlug: 'proj', workspaceId: 'caller-workspace', permissionMode: 'accept-edits', baseBranch: 'main',
      })
      await recordWorkspaceCreated({
        projectSlug: 'proj', workspaceId: 'loose-sibling', permissionMode: 'bypass', baseBranch: 'main',
      })
    })

    const ME = { 'parent-workspace': 'caller-workspace' }

    it('queues under the named parent, prints the id, and chains after it', async () => {
      const first = await output('queue', 'step 2', { ...ME, tool: 'claude' })
      expect(first).toMatch(/^[0-9a-f-]{36}$/)
      const second = await output('queue', 'step 3', { 'parent-workspace': first.slice(0, 8) })

      const rows = await listQueuedWorkspaceRows('proj')
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
      const group = (await listWorkspaceGroupRows('proj')).find((g) => g.name === 'follow-ups')
      expect((await listQueuedWorkspaceRows('proj')).find((r) => r.id === id)).toMatchObject({
        tool: 'claude', model: 'opus', permissionMode: 'manual', mode: 'acp',
        branch: 'feature/x', groupId: group?.groupId, title: 'Step two',
      })
    })

    it('never grants more than the caller has, and refuses rather than queueing', async () => {
      // Under a more permissive sibling, the mode is capped at the caller's.
      await output('queue', 'x', { 'parent-workspace': 'loose-sibling', tool: 'claude' })
      expect((await listQueuedWorkspaceRows('proj'))[0].permissionMode).toBe('accept-edits')

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
      expect(await listQueuedWorkspaceRows('proj')).toHaveLength(1)
    })
  })

  describe('edit-queued', () => {
    beforeEach(async () => {
      await recordWorkspaceCreated({
        projectSlug: 'proj', workspaceId: 'caller-workspace', permissionMode: 'accept-edits', baseBranch: 'main',
      })
      await recordWorkspaceCreated({
        projectSlug: 'proj', workspaceId: 'loose-sibling', permissionMode: 'bypass', baseBranch: 'main',
      })
      await recordWorkspaceCreated({ projectSlug: 'other', workspaceId: 'foreign-workspace', baseBranch: 'main' })
    })

    const ME = { 'parent-workspace': 'caller-workspace' }
    const rowOf = async (id: string, slug = 'proj') =>
      (await listQueuedWorkspaceRows(slug)).find((r) => r.id === id)

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
      const group = (await listWorkspaceGroupRows('proj')).find((g) => g.name === 'later')
      expect(await rowOf(id)).toMatchObject({
        prompt: 'step 2, but also run the linter', parentWorkspaceId: 'loose-sibling', model: 'sonnet',
        permissionMode: 'plan', mode: 'acp', branch: 'feature/y', groupId: group?.groupId, title: 'Lint too',
      })
    })

    it('holds an entry the user queued above the caller to its ceiling', async () => {
      // The user queued this at `bypass`; an agent in `accept-edits` may not
      // rewrite its prompt, and the mode is not silently lowered.
      const entry = await queueWorkspace('proj', {
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
      const foreign = await queueWorkspace('other', {
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
      expect(await rowOf(foreign.id, 'other')).toMatchObject({ prompt: 'theirs' })
      expect(await rowOf(id)).toMatchObject({ prompt: 'mine', parentWorkspaceId: 'caller-workspace' })
    })
  })

  describe('rename', () => {
    beforeEach(async () => {
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'caller-workspace' })
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'sibling-workspace' })
    })

    const titleOf = async (id: string, slug = 'proj'): Promise<string | undefined> =>
      (await getProjectWorkspaceRows(slug)).get(id)?.title

    it('renames the CALLER when no workspace is named', async () => {
      // With no workspace named, an agent renames itself.
      const text = await output('rename', 'porting the lexer to rust')

      expect(await titleOf('caller-workspace')).toBe('porting the lexer to rust')
      expect(text).toContain('porting the lexer to rust')
    })

    it('is readable back through list, which is the only view an agent has', async () => {
      await output('rename', 'porting the lexer')
      vi.mocked(listWorkspacePods).mockResolvedValue([podFor('caller-workspace')])
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
      await recordWorkspaceCreated({ projectSlug: 'other', workspaceId: 'foreign-workspace' })
      const outcome = await run('rename', 'mine now', { workspace: 'foreign-workspace' })
      expect(outcome.ok).toBe(false)
      expect(await titleOf('foreign-workspace', 'other')).toBeUndefined()
    })
  })

  describe('stop', () => {
    beforeEach(async () => {
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'caller-workspace' })
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'sibling-workspace' })
      vi.mocked(listWorkspacePods).mockResolvedValue([
        podFor('caller-workspace'), podFor('sibling-workspace'),
      ])
    })

    it('stops a sibling by short id prefix, keeping what makes it restartable', async () => {
      const text = await output('stop', '', { workspace: 'sibling' })

      // The resolved workspace is the one handed to the teardown.
      expect(vi.mocked(cleanupWorkspaceDetached)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(cleanupWorkspaceDetached).mock.calls[0][0]).toMatchObject({
        workspaceId: 'sibling-workspace',
        projectSlug: 'proj',
        jobName: 'yaac-proj-sibling-workspace',
      })
      expect(text).toContain('sibling-')
      // The reply must say a stop is reversible, or an agent may treat it as
      // a delete.
      expect(text).toContain('checkout is kept')
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
      vi.mocked(listWorkspacePods).mockResolvedValue([])

      const outcome = await run('stop', '', { workspace: 'sibling' })

      expect(outcome).toEqual({ ok: false, error: 'workspace sibling- is not running' })
      expect(vi.mocked(cleanupWorkspaceDetached)).not.toHaveBeenCalled()
    })

    it('cannot stop another project\'s workspace', async () => {
      await recordWorkspaceCreated({ projectSlug: 'other', workspaceId: 'foreign-workspace' })
      vi.mocked(listWorkspacePods).mockResolvedValue([podFor('foreign-workspace', 'other')])

      const outcome = await run('stop', '', { workspace: 'foreign-workspace' })

      expect(outcome.ok).toBe(false)
      expect(vi.mocked(cleanupWorkspaceDetached)).not.toHaveBeenCalled()
    })

    it('refuses an ambiguous prefix rather than stopping the wrong workspace', async () => {
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'sibling-second' })

      const outcome = await run('stop', '', { workspace: 'sibling' })

      expect(outcome.ok).toBe(false)
      // Distinct from "no such workspace": the caller has the right id and
      // typed too little of it.
      if (!outcome.ok) expect(outcome.error).toContain('use a longer prefix')
      expect(vi.mocked(cleanupWorkspaceDetached)).not.toHaveBeenCalled()
    })
  })

  describe('send', () => {
    beforeEach(async () => {
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'caller-workspace', permissionMode: 'accept-edits' })
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'sibling-workspace', permissionMode: 'manual' })
      vi.mocked(listWorkspacePods).mockResolvedValue([podFor('caller-workspace'), podFor('sibling-workspace')])
      await recordAgentSessions('proj', 'sibling-workspace', [
        { tool: 'claude', agentSessionId: 'first-conv' },
        { tool: 'claude', agentSessionId: 'second-conv' },
      ])
      await setActiveAgentSessions('proj', 'sibling-workspace', [
        { tool: 'claude', agentSessionId: 'first-conv', paneId: '%3' },
        { tool: 'claude', agentSessionId: 'second-conv', paneId: '%7' },
      ])
      vi.mocked(podExec).mockReset().mockResolvedValue({ stdout: '', stderr: '' })
      _resetWorkspaceStatusStoreForTests()
    })

    /** The delivery script a command carries, base64-encoded. */
    const scriptOf = (cmd: string): string =>
      Buffer.from(/^sh -c "\$\(printf %s (\S+) \| base64 -d\)"$/.exec(cmd)![1], 'base64').toString('utf8')

    /** The pane the paste script targets, and whether it carries the
     *  message. It runs in the foreground, so the reply can say whether the
     *  message landed. */
    const delivered = (message: string): { jobName: string; pane?: string; carries: boolean } => {
      const [jobName, cmd] = vi.mocked(podExec).mock.calls.at(-1)!
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
        jobName: 'yaac-proj-sibling-workspace', pane: '%3', carries: true,
      })
      expect(text).toContain('Sent to sibling-')
      expect(text).toContain('first-co')

      // Each delivery checks its own conversation for a dialog first.
      expect(scriptOf(vi.mocked(podExec).mock.calls.at(-1)![1])).toContain('first-conv')

      await output('send', 'and you', { workspace: 'sibling', conversation: 'second' })
      expect(delivered('Sent from caller-workspace via yaac-mama:\n\nand you').pane).toBe('%7')
      expect(scriptOf(vi.mocked(podExec).mock.calls.at(-1)![1])).toContain('second-conv')
    })

    it('strips control characters before any tool sees them, pi\'s editor-free path included', async () => {
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'pi-workspace', permissionMode: 'manual' })
      await recordAgentSessions('proj', 'pi-workspace', [{ tool: 'pi', agentSessionId: 'pi-conv' }])
      await setActiveAgentSessions('proj', 'pi-workspace', [{ tool: 'pi', agentSessionId: 'pi-conv', paneId: '%5' }])
      vi.mocked(listWorkspacePods).mockResolvedValue([podFor('caller-workspace'), podFor('pi-workspace')])

      await output('send', 'look\x1b]52;c;cGF5bG9hZA==\x07 here\x1b[6n', { workspace: 'pi-workspace' })

      // An OSC clipboard write and a cursor query, rendered by pi's TUI,
      // would reach the terminal; only their printable remains arrive.
      expect(delivered('Sent from caller-workspace via yaac-mama:\n\nlook]52;c;cGF5bG9hZA== here[6n'))
        .toMatchObject({ pane: '%5', carries: true })
    })

    it('reports a message the agent could not take as not delivered', async () => {
      vi.mocked(podExec).mockRejectedValue(new WorkspaceExecError('paste', 1, '', 'prompt never appeared'))

      const outcome = await run('send', 'go', { workspace: 'sibling' })

      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error).toMatch(/^not delivered to sibling-'s claude conversation first-co: .*nothing was submitted/)

      // The paste script found a dialog up, so it typed nothing.
      vi.mocked(podExec).mockRejectedValue(new WorkspaceExecError('paste', 3, '', 'showing a prompt'))
      const asking = await run('send', 'go', { workspace: 'sibling' })
      expect(asking.ok === false && asking.error).toContain('nothing was typed')
    })

    it('delivers one message at a time per sender and per conversation', async () => {
      let release!: () => void
      vi.mocked(podExec).mockReturnValueOnce(new Promise((resolve) => {
        release = () => resolve({ stdout: '', stderr: '' })
      }))
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'third-workspace', permissionMode: 'manual' })
      vi.mocked(listWorkspacePods).mockResolvedValue([
        podFor('caller-workspace'), podFor('sibling-workspace'), podFor('third-workspace'),
      ])
      const third = { ...CALLER, workspaceId: 'third-workspace' }

      const first = run('send', 'one', { workspace: 'sibling' })
      await vi.waitFor(() => { expect(vi.mocked(podExec)).toHaveBeenCalledTimes(1) })
      const again = await run('send', 'two', { workspace: 'sibling', conversation: 'second' })
      const other = await runMamaCommand(third, { command: 'send', args: { workspace: 'sibling' }, body: 'three' })
      release()

      expect(again.ok === false && again.error).toContain('previous send is still being delivered')
      expect(other.ok === false && other.error).toContain('another message to sibling-')
      expect((await first).ok).toBe(true)
      expect(vi.mocked(podExec)).toHaveBeenCalledTimes(1)
      // Both free again once it lands.
      expect((await run('send', 'two', { workspace: 'sibling' })).ok).toBe(true)
    })

    it('refuses a target it must not or cannot message, sending nothing', async () => {
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'bypass-workspace', permissionMode: 'bypass' })
      await recordAgentSessions('proj', 'bypass-workspace', [{ tool: 'claude', agentSessionId: 'bypass-conv' }])
      await setActiveAgentSessions('proj', 'bypass-workspace', [{ tool: 'claude', agentSessionId: 'bypass-conv', paneId: '%1' }])
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'stopped-workspace', permissionMode: 'plan' })
      await recordWorkspaceCreated({ projectSlug: 'other', workspaceId: 'foreign-workspace', permissionMode: 'plan' })
      vi.mocked(listWorkspacePods).mockResolvedValue([
        podFor('caller-workspace'), podFor('sibling-workspace'), podFor('bypass-workspace'),
        podFor('foreign-workspace', 'other'),
      ])
      const refusal = async (body: string, args: Record<string, string>): Promise<string> => {
        const outcome = await run('send', body, args)
        if (outcome.ok) throw new Error(`expected a refusal for ${JSON.stringify(args)}`)
        return outcome.error
      }

      // A message is as good as a prompt, so the caller's posture caps it:
      // the row's, and the conversation's own when it reported one.
      expect(await refusal('go', { workspace: 'bypass' })).toContain('more than this workspace\'s own')
      setLiveAgents('proj', 'sibling-workspace', [
        { handle: '%3', tool: 'claude', agentSessionId: 'first-conv', reportedMode: 'bypassPermissions' },
        { handle: '%7', tool: 'claude', agentSessionId: 'second-conv', reportedMode: 'mystery' },
      ])
      expect(await refusal('go', { workspace: 'sibling' })).toContain('runs in permission mode \'bypass\'')
      expect(await refusal('go', { workspace: 'sibling', conversation: 'second' })).toContain('cannot tell which permission mode')
      _resetWorkspaceStatusStoreForTests()

      expect(await refusal('go', { workspace: 'caller-workspace' })).toContain('itself')
      expect(await refusal('go', { workspace: 'stopped' })).toBe('workspace stopped- is not running')
      expect(await refusal('go', { workspace: 'foreign-workspace' })).toContain('no workspace')
      expect(await refusal('go', { workspace: 'sibling', conversation: 'nope' })).toContain('no running conversation')
      expect(await refusal('  ', { workspace: 'sibling' })).toContain('needs a message')
      await setActiveAgentSessions('proj', 'sibling-workspace', [])
      expect(await refusal('go', { workspace: 'sibling' })).toContain('has no running conversation yet')
      expect(vi.mocked(podExec)).not.toHaveBeenCalled()
    })
  })

  describe('group-create', () => {
    it('makes an empty group the caller can then file workspaces into', async () => {
      const text = await output('group-create', 'release train')
      expect(text).toContain('release train')

      const rows = await listWorkspaceGroupRows('proj')
      expect(rows).toHaveLength(1)
      // Pinned, or an empty group would not be listed anywhere.
      expect(rows[0]).toMatchObject({ name: 'release train', pinned: true })
    })

    it('is idempotent, so an agent can name a group without checking first', async () => {
      await output('group-create', 'review')
      await output('group-create', 'review')
      expect(await listWorkspaceGroupRows('proj')).toHaveLength(1)
    })

    it('reports the name as stored, not as typed', async () => {
      // The store collapses whitespace, so the reply shows the stored name,
      // and the same input must reach the same group.
      const text = await output('group-create', 'release   train')
      expect(text).toContain('"release train"')

      await output('group-create', ' release train ')
      expect(await listWorkspaceGroupRows('proj')).toHaveLength(1)
    })

    it('refuses a name longer than the store keeps', async () => {
      // A name accepted then truncated would let two long names sharing a
      // prefix resolve to one group.
      const outcome = await run('group-create', 'x'.repeat(MAX_TITLE_LENGTH + 1))
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error).toContain(`exceeds ${MAX_TITLE_LENGTH}`)
      expect(await listWorkspaceGroupRows('proj')).toEqual([])
    })

    it('refuses a blank name', async () => {
      const outcome = await run('group-create', '   ')
      expect(outcome).toEqual({ ok: false, error: 'group name must not be empty' })
      expect(await listWorkspaceGroupRows('proj')).toEqual([])
    })
  })

  describe('group-move', () => {
    beforeEach(async () => {
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'aaaabbbb-1111-2222' })
    })

    const groupOf = async (id: string, slug = 'proj'): Promise<string | undefined> =>
      (await getProjectWorkspaceRows(slug)).get(id)?.groupId

    it('files a workspace by short id prefix, creating the group', async () => {
      const text = await output('group-move', 'release', { workspace: 'aaaabbbb' })
      expect(text).toContain('into "release"')

      const rows = await listWorkspaceGroupRows('proj')
      expect(await groupOf('aaaabbbb-1111-2222')).toBe(rows[0].groupId)
    })

    it('reports the group’s name when it was addressed by id', async () => {
      // The ambiguity error tells agents to pass an id, so the reply must
      // name the group, not echo a uuid.
      const group = await createWorkspaceGroup('proj', 'release train', null)

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
      expect(await listWorkspaceGroupRows('proj')).toHaveLength(1)
    })

    it('cannot move another project\'s workspace', async () => {
      await recordWorkspaceCreated({ projectSlug: 'other', workspaceId: 'foreign-workspace' })

      const outcome = await run('group-move', 'release', { workspace: 'foreign-workspace' })

      expect(outcome.ok).toBe(false)
      expect(await groupOf('foreign-workspace', 'other')).toBeUndefined()
    })

    it('refuses an ambiguous prefix rather than moving the wrong workspace', async () => {
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'aaaabbbb-3333-4444' })
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
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'sibling-workspace' })
      await recordWorkspaceCreated({ projectSlug: 'other', workspaceId: 'foreign-workspace' })
      const checkout = workspaceDir('proj', 'sibling-workspace')
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
        .toEqual({ ok: false, error: 'no workspace \'foreign-workspace\' in proj' })
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
      await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'sibling-workspace' })
      await recordWorkspaceCreated({ projectSlug: 'other', workspaceId: 'foreign-workspace' })
      await recordAgentSessions('proj', 'sibling-workspace', [
        { tool: 'claude', agentSessionId: 'claude-conv', firstPrompt: 'write the report' },
        { tool: 'opencode', agentSessionId: 'opencode-conv' },
      ])
      const conversations = path.join(agentHistoryDir('proj', 'sibling-workspace', 'claude'), '-workspace')
      await fs.mkdir(path.join(conversations, 'claude-conv', 'subagents'), { recursive: true })
      // The main transcript lacks its final newline, as a live one can.
      await fs.writeFile(path.join(conversations, 'claude-conv.jsonl'), '{"main":1}')
      await fs.writeFile(path.join(conversations, 'claude-conv', 'subagents', 'agent-a.jsonl'), '{"sub":1}\n')
      await fs.mkdir(opencodeCheckpointDir('proj', 'sibling-workspace'), { recursive: true })
      await fs.writeFile(path.join(opencodeCheckpointDir('proj', 'sibling-workspace'), 'opencode.db'), 'SQLite')

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
        .toEqual({ ok: false, error: 'no workspace \'foreign-workspace\' in proj' })
      expect(await run('history')).toEqual({ ok: false, error: 'history needs a workspace id' })
    })
  })

  describe('models', () => {
    it('reports every tool, and which the host can actually authenticate', async () => {
      // No credentials are seeded, so every tool reads as unconfigured.
      const text = await output('models')
      expect(text).toContain('claude')
      expect(text).toContain('codex')
      expect(text).toContain('opencode')
      expect(text).toContain('pi')
      expect(text).toContain('not configured')
      // It names the caller's own tool, the known-good default.
      expect(text).toContain('codex')
    })
  })
})

function podFor(workspaceId: string, projectSlug = 'proj'): podsModule.PodInfo {
  return {
    jobName: `yaac-${projectSlug}-${workspaceId}`,
    podName: `yaac-${projectSlug}-${workspaceId}-abcde`,
    workspaceId: workspaceId,
    projectSlug,
    projectId: '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 1_760_000_000_000,
    labels: {},
  }
}
