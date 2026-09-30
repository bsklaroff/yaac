import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installRealWorkspaceDriver } from '@yaac/test-utils/real-driver'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

// The command handler composes real db and real group resolution — those are
// what the commands DO. Mocked at the process boundaries only: the substrate
// listings behind `listActiveWorkspaces` and the teardown resolve, the create
// a spawn detaches into, and the teardown a stop detaches into.
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

import { listWorkspacePods } from '#drivers/k8s/substrate/pods'
import type * as podsModule from '#drivers/k8s/substrate/pods'
import type * as createModule from '#domain/workspaces/create'
import { createWorkspace } from '#domain/workspaces/create'
import type { WorkspaceCreateResult } from '#domain/workspaces/create'
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

const CALLER: MamaCaller = {
  workspaceId: 'caller-workspace',
  projectSlug: 'proj',
  tool: 'codex',
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  installRealWorkspaceDriver()
  // `list` is a join over a project that exists; the caller's own project
  // always does, since it is where the caller is running.
  await recordProject({ slug: 'proj', remoteUrl: 'https://example.com/proj', addedAt: '2026-01-01T00:00:00.000Z' })
  await recordProject({ slug: 'other', remoteUrl: 'https://example.com/other', addedAt: '2026-01-01T00:00:00.000Z' })
  clearAllProvisioningForTests()
  _clearListActiveInflightForTests()
  vi.mocked(listWorkspacePods).mockResolvedValue([])
  vi.mocked(cleanupWorkspaceDetached).mockReset().mockResolvedValue()
  vi.mocked(createWorkspace).mockReset().mockResolvedValue({
    workspaceId: 'spawned', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui',
  } as WorkspaceCreateResult)
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** Let a detached create's .then/.finally chains settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Wait for the detached create to reach the (mocked) create — it resolves
 *  the setup and looks for a spare first, which takes more than a tick. */
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
  return outcome.output
}

describe('runMamaCommand', () => {
  it('refuses a command outside the allowlist, naming what is allowed', async () => {
    // The union IS the subset of the yaac CLI a workspace may reach, and this
    // is where it is enforced for BOTH transports — the proxy queues
    // envelopes without knowing what any of them mean.
    for (const forbidden of ['delete', 'restart', 'workspace-stop', 'config', '']) {
      const outcome = await run(forbidden)
      expect(outcome.ok, forbidden).toBe(false)
      if (!outcome.ok) expect(outcome.error).toContain('unknown command')
    }
    // The refusal tells the caller what it could have said instead.
    const outcome = await run('delete')
    if (!outcome.ok) {
      expect(outcome.error).toContain('create')
      expect(outcome.error).toContain('group-move')
    }
  })

  it('refuses an option the command does not take, rather than ignoring it', async () => {
    // Both transports land here, so this is where the two are made to agree:
    // the proxy shape-checks what it queues, but a containerless workspace
    // posts straight to the route and never passes through it. Silently
    // dropping an option would let a request do something other than it said.
    const wrong = await run('rename', 'a title', { group: 'nope' })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.error).toContain("does not take '--group'")

    const none = await run('list', '', { workspace: 'x' })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.error).toContain('takes no options')

    // Prototype names get the same treatment as any other unknown option.
    const proto = await run('list', '', { constructor: 'x' })
    expect(proto.ok).toBe(false)

    // What each command DOES take still passes.
    await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'caller-workspace' })
    expect((await run('create', 'p', {
      tool: 'claude', model: 'opus', 'permission-mode': 'plan', 'ui-mode': 'acp', branch: 'b', group: 'g', title: 't',
    })).ok).toBe(true)
  })

  it('answers rather than throws when a command fails', async () => {
    // A transport is holding a caller's request open, so every path has to
    // produce something to answer with.
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
      // The group column is how a reader knows what `group move` would change.
      expect(text).toMatch(/WORKSPACE\s+TOOL\s+STATUS\s+GROUP\s+PROMPT/)
      expect(group.name).toBe('review')
    })

    it('says so plainly when there is nothing to report', async () => {
      const text = await output('list')
      expect(text).toContain('No running workspaces in proj')
      expect(text).toContain('No groups yet')
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
        projectSlug: 'proj', workspaceId: 'caller-workspace', permissionMode: 'auto',
      })
    })

    it('starts a workspace in the caller\'s project and returns just the id', async () => {
      const outcome = await run('create', 'write the report')
      expect(outcome.ok).toBe(true)
      // The bare id, so `id=$(yaac-mama create "…")` is the working idiom.
      if (outcome.ok) expect(outcome.output).toMatch(/^[0-9a-f-]{36}$/)
      await created()

      expect(vi.mocked(createWorkspace)).toHaveBeenCalledTimes(1)
      const [slug, opts] = vi.mocked(createWorkspace).mock.calls[0]
      expect(slug).toBe('proj')
      // The caller's own tool and posture, absent a request for others.
      expect(opts).toMatchObject({ initialPrompt: 'write the report', tool: 'codex', permissionMode: 'auto' })
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

      // The ceiling is read off the caller's recorded row, which the request
      // cannot speak for.
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
      // Resolved to an id before the create, so the workspace is filed from
      // the moment its row exists rather than when provisioning finishes.
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
    // A request refused anywhere — the posture ceiling, an unknown parent, a
    // user's entry above the caller — must not change the user's sidebar.
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

    it('takes the option names an older install\'s yaac-mama sends', async () => {
      const id = await output('queue', 'step 2', { 'parent-worktree': 'caller-workspace' })
      expect((await listQueuedWorkspaceRows('proj')).find((r) => r.id === id))
        .toMatchObject({ parentWorkspaceId: 'caller-workspace' })
      await output('rename', 'renamed the old way', { worktree: 'loose-sibling' })
      expect((await getProjectWorkspaceRows('proj')).get('loose-sibling')?.title).toBe('renamed the old way')
    })

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

      // And list shows the chain, one level deeper per link.
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
      // Under a looser sibling, its posture is stepped down to the caller's.
      await output('queue', 'x', { 'parent-workspace': 'loose-sibling', tool: 'claude' })
      expect((await listQueuedWorkspaceRows('proj'))[0].permissionMode).toBe('accept-edits')

      const refusals: Array<Record<string, string>> = [
        // Named above the ceiling.
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

      // Options alone leave the prompt; every one create takes is here, and
      // so is the parent.
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
      // put its own words behind that grant, and it is not quietly lowered.
      const entry = await queueWorkspace('proj', {
        parent: 'loose-sibling', prompt: 'user wrote this', tool: 'claude', permissionMode: 'bypass',
      }, 'user')
      const refused = await run('edit-queued', 'agent wrote this', { queued: entry.id })
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.error).toContain('more permissive than this workspace')
      expect(await rowOf(entry.id)).toMatchObject({ prompt: 'user wrote this', permissionMode: 'bypass' })

      // Naming one at or below the caller's own is the way through.
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
      // The common use: an agent that has worked out what it is doing says
      // so, without first looking up an id it only needs to name itself.
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
      // The caller is untouched — naming a workspace means that workspace.
      expect(await titleOf('caller-workspace')).toBeUndefined()
    })

    it('reports the stored title, not the one that was sent', async () => {
      // The store trims, collapses whitespace and caps the length, so
      // echoing the request would tell the caller something untrue.
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

      // The teardown is the driver's; what this owns is that the RESOLVED
      // workspace is the one handed to it.
      expect(vi.mocked(cleanupWorkspaceDetached)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(cleanupWorkspaceDetached).mock.calls[0][0]).toMatchObject({
        workspaceId: 'sibling-workspace',
        projectSlug: 'proj',
        jobName: 'yaac-proj-sibling-workspace',
      })
      expect(text).toContain('sibling-')
      // The line has to say this was reversible, or an agent reads a stop as
      // a delete and never offers the user the restart.
      expect(text).toContain('checkout is kept')
    })

    it('stops the CALLER when no workspace is named', async () => {
      // The case the command exists for: a workspace spawned to do one job
      // winding itself down once the job is done.
      await output('stop')

      expect(vi.mocked(cleanupWorkspaceDetached).mock.calls[0][0]).toMatchObject({
        workspaceId: 'caller-workspace',
      })
    })

    it('reports a workspace that is not running as such, not as unknown', async () => {
      // The row resolved, so the workspace exists — it just has no unit. The
      // driver's own NOT_FOUND sends a caller to `yaac workspace list`, which
      // an agent does not have.
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
      // Told apart from "no such workspace", because the two ask the caller
      // for different things — and behind a teardown that difference is the
      // whole message: it holds the right id and typed too little of it.
      if (!outcome.ok) expect(outcome.error).toContain('use a longer prefix')
      expect(vi.mocked(cleanupWorkspaceDetached)).not.toHaveBeenCalled()
    })
  })

  describe('group-create', () => {
    it('makes an empty group the caller can then file workspaces into', async () => {
      const text = await output('group-create', 'release train')
      expect(text).toContain('release train')

      const rows = await listWorkspaceGroupRows('proj')
      expect(rows).toHaveLength(1)
      // Pinned, or a memberless group would be listed by nothing.
      expect(rows[0]).toMatchObject({ name: 'release train', pinned: true })
    })

    it('is idempotent, so an agent can name a group without checking first', async () => {
      await output('group-create', 'review')
      await output('group-create', 'review')
      expect(await listWorkspaceGroupRows('proj')).toHaveLength(1)
    })

    it('reports the name as stored, not as typed', async () => {
      // The store collapses whitespace, so the typed string is not what the
      // sidebar will show — and the same typing has to reach the same group
      // rather than making a second one beside it.
      const text = await output('group-create', 'release   train')
      expect(text).toContain('"release train"')

      await output('group-create', ' release train ')
      expect(await listWorkspaceGroupRows('proj')).toHaveLength(1)
    })

    it('refuses a name longer than the store keeps', async () => {
      // Bounded by what the store will hold, not by something larger: a name
      // accepted and then truncated would let two distinct long names
      // sharing a prefix resolve to one group.
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
      // Passing an id is exactly what the ambiguity error tells an agent to
      // do, so the line it reads back must not be a uuid.
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
      // The fix is a longer prefix, so the message says so rather than
      // sending the caller back to `list` for an id it already has.
      if (!outcome.ok) expect(outcome.error).toContain('use a longer prefix')
    })

    it('needs a workspace to move', async () => {
      const outcome = await run('group-move', 'release')
      expect(outcome).toEqual({ ok: false, error: 'group move needs a workspace id' })
    })
  })

  describe('models', () => {
    it('reports every tool, and which the host can actually authenticate', async () => {
      // No credentials seeded in this data dir, so every tool reads
      // unconfigured — the answer an agent needs before choosing --tool.
      const text = await output('models')
      expect(text).toContain('claude')
      expect(text).toContain('codex')
      expect(text).toContain('opencode')
      expect(text).toContain('pi')
      expect(text).toContain('not configured')
      // It says which tool the caller itself runs, the known-good default.
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
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 1_760_000_000_000,
    labels: {},
  }
}
