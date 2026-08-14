import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installRealWorktreeDriver } from '@yaac/test-utils/real-driver'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

// The command handler composes real db and real group resolution — those are
// what the commands DO. Mocked at the two process boundaries only: the
// substrate listing behind `listActiveWorktrees`, and the create a spawn
// detaches into.
vi.mock('#drivers/k8s/substrate/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return { ...actual, listWorktreePods: vi.fn().mockResolvedValue([]) }
})
vi.mock('#domain/worktrees/create', () => ({ createWorktree: vi.fn() }))

import { listWorktreePods } from '#drivers/k8s/substrate/pods'
import type * as podsModule from '#drivers/k8s/substrate/pods'
import { createWorktree } from '#domain/worktrees/create'
import type { WorktreeCreateResult } from '#domain/worktrees/create'
import { closeDb } from '#db/client'
import { createWorktreeGroup, listWorktreeGroupRows } from '#db/group-store'
import { getProjectWorktreeRows, recordWorktreeCreated } from '#db/worktree-store'
import { recordProject } from '#db/project-store'
import { clearAllProvisioningForTests } from '#domain/worktrees/provisioning'
import { _clearListActiveInflightForTests } from '#domain/worktrees/list'
import { runMamaCommand, type MamaCaller } from '#domain/worktrees/mama'

const CALLER: MamaCaller = {
  workspaceId: 'caller-session',
  projectSlug: 'proj',
  tool: 'codex',
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  installRealWorktreeDriver()
  // `list` is a join over a project that exists; the caller's own project
  // always does, since it is where the caller is running.
  await recordProject({ slug: 'proj', remoteUrl: 'https://example.com/proj', addedAt: '2026-01-01T00:00:00.000Z' })
  await recordProject({ slug: 'other', remoteUrl: 'https://example.com/other', addedAt: '2026-01-01T00:00:00.000Z' })
  clearAllProvisioningForTests()
  _clearListActiveInflightForTests()
  vi.mocked(listWorktreePods).mockResolvedValue([])
  vi.mocked(createWorktree).mockReset().mockResolvedValue({
    worktreeId: 'spawned', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui',
  } as WorktreeCreateResult)
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** Let a detached create's .then/.finally chains settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

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
    // The union IS the subset of the yaac CLI a session may reach, and this
    // is where it is enforced for BOTH transports — the proxy queues
    // envelopes without knowing what any of them mean.
    for (const forbidden of ['stop', 'delete', 'restart', 'worktree-stop', '']) {
      const outcome = await run(forbidden)
      expect(outcome.ok, forbidden).toBe(false)
      if (!outcome.ok) expect(outcome.error).toContain('unknown command')
    }
    // The refusal tells the caller what it could have said instead.
    const outcome = await run('stop')
    if (!outcome.ok) {
      expect(outcome.error).toContain('create')
      expect(outcome.error).toContain('group-move')
    }
  })

  it('refuses an option the command does not take, rather than ignoring it', async () => {
    // Both transports land here, so this is where the two are made to agree:
    // the proxy shape-checks what it queues, but a containerless worktree
    // posts straight to the route and never passes through it. Silently
    // dropping an option would let a request do something other than it said.
    const wrong = await run('rename', 'a title', { group: 'nope' })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.error).toContain("does not take '--group'")

    const none = await run('list', '', { session: 'x' })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.error).toContain('takes no options')

    // Prototype names get the same treatment as any other unknown option.
    const proto = await run('list', '', { constructor: 'x' })
    expect(proto.ok).toBe(false)

    // What each command DOES take still passes.
    expect((await run('create', 'p', { tool: 'claude', model: 'opus', group: 'g' })).ok).toBe(true)
  })

  it('answers rather than throws when a command fails', async () => {
    // A transport is holding a caller's request open, so every path has to
    // produce something to answer with.
    const outcome = await run('group-move', 'anywhere', { session: 'nope' })
    expect(outcome).toEqual({ ok: false, error: "no session 'nope' in proj" })
  })

  describe('list', () => {
    it('reports the project\'s sessions and groups, marking the caller', async () => {
      await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'caller-session' })
      await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'other-session' })
      const group = await createWorktreeGroup('proj', 'review', 'other-session')
      vi.mocked(listWorktreePods).mockResolvedValue([
        podFor('caller-session'), podFor('other-session'),
      ])

      const text = await output('list')

      expect(text).toContain('caller-session'.slice(0, 8))
      expect(text).toContain('(you)')
      expect(text).toContain('review')
      // The group column is how a reader knows what `group move` would change.
      expect(text).toMatch(/SESSION\s+TOOL\s+STATUS\s+GROUP\s+PROMPT/)
      expect(group.name).toBe('review')
    })

    it('says so plainly when there is nothing to report', async () => {
      const text = await output('list')
      expect(text).toContain('No running sessions in proj')
      expect(text).toContain('No groups yet')
    })

    it('never shows another project\'s sessions', async () => {
      await recordWorktreeCreated({ projectSlug: 'other', worktreeId: 'elsewhere' })
      await createWorktreeGroup('other', 'theirs', 'elsewhere')
      vi.mocked(listWorktreePods).mockResolvedValue([podFor('elsewhere', 'other')])

      const text = await output('list')

      expect(text).not.toContain('elsewhere')
      expect(text).not.toContain('theirs')
    })
  })

  describe('create', () => {
    it('starts a worktree in the caller\'s project and returns just the id', async () => {
      const outcome = await run('create', 'write the report')
      expect(outcome.ok).toBe(true)
      // The bare id, so `id=$(yaac-mama create "…")` is the working idiom.
      if (outcome.ok) expect(outcome.output).toMatch(/^[0-9a-f-]{36}$/)
      await settle()

      expect(vi.mocked(createWorktree)).toHaveBeenCalledTimes(1)
      const [slug, opts] = vi.mocked(createWorktree).mock.calls[0]
      expect(slug).toBe('proj')
      expect(opts).toMatchObject({ initialPrompt: 'write the report', tool: 'codex' })
    })

    it('files the new worktree into a group, creating it by name', async () => {
      const outcome = await run('create', 'do it', { group: 'release train' })
      expect(outcome.ok).toBe(true)
      await settle()

      const rows = await listWorktreeGroupRows('proj')
      expect(rows.map((r) => r.name)).toEqual(['release train'])
      // Resolved to an id before the create, so the worktree is filed from
      // the moment its row exists rather than when provisioning finishes.
      const [, opts] = vi.mocked(createWorktree).mock.calls[0]
      expect(opts.groupId).toBe(rows[0].groupId)
    })

    it('reuses an existing group rather than making a second of the same name', async () => {
      const existing = await createWorktreeGroup('proj', 'review', null)
      await run('create', 'do it', { group: 'review' })
      await settle()

      expect(await listWorktreeGroupRows('proj')).toHaveLength(1)
      expect(vi.mocked(createWorktree).mock.calls[0][1].groupId).toBe(existing.groupId)
    })

    it('relays the policy\'s refusal instead of starting anything', async () => {
      const outcome = await run('create', '   ')
      expect(outcome).toEqual({ ok: false, error: 'prompt must not be empty' })
      await settle()
      expect(vi.mocked(createWorktree)).not.toHaveBeenCalled()
    })
  })

  describe('rename', () => {
    beforeEach(async () => {
      await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'caller-session' })
      await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'sibling-session' })
    })

    const titleOf = async (id: string, slug = 'proj'): Promise<string | undefined> =>
      (await getProjectWorktreeRows(slug)).get(id)?.title

    it('renames the CALLER when no session is named', async () => {
      // The common use: an agent that has worked out what it is doing says
      // so, without first looking up an id it only needs to name itself.
      const text = await output('rename', 'porting the lexer to rust')

      expect(await titleOf('caller-session')).toBe('porting the lexer to rust')
      expect(text).toContain('porting the lexer to rust')
    })

    it('is readable back through list, which is the only view an agent has', async () => {
      await output('rename', 'porting the lexer')
      vi.mocked(listWorktreePods).mockResolvedValue([podFor('caller-session')])
      _clearListActiveInflightForTests()

      const listed = await output('list')
      expect(listed).toMatch(/SESSION\s+TOOL\s+STATUS\s+GROUP\s+TITLE\s+PROMPT/)
      expect(listed).toContain('porting the lexer')
    })

    it('renames a sibling by short id prefix', async () => {
      await output('rename', 'reviewing the PR', { session: 'sibling' })
      expect(await titleOf('sibling-session')).toBe('reviewing the PR')
      // The caller is untouched — naming a session means that session.
      expect(await titleOf('caller-session')).toBeUndefined()
    })

    it('reports the stored title, not the one that was sent', async () => {
      // The store trims, collapses whitespace and caps the length, so
      // echoing the request would tell the caller something untrue.
      const text = await output('rename', `  spaced   out  ${'x'.repeat(200)}`)
      const stored = await titleOf('caller-session')
      expect(stored).toHaveLength(120)
      expect(stored?.startsWith('spaced out ')).toBe(true)
      expect(text).toContain(stored!)
    })

    it('refuses an empty title and a session it cannot find', async () => {
      expect(await run('rename', '   ')).toEqual({ ok: false, error: 'rename needs a title' })
      expect(await titleOf('caller-session')).toBeUndefined()

      const missing = await run('rename', 'x', { session: 'nope' })
      expect(missing.ok).toBe(false)
    })

    it('cannot rename another project\u2019s session', async () => {
      await recordWorktreeCreated({ projectSlug: 'other', worktreeId: 'foreign-session' })
      const outcome = await run('rename', 'mine now', { session: 'foreign-session' })
      expect(outcome.ok).toBe(false)
      expect(await titleOf('foreign-session', 'other')).toBeUndefined()
    })
  })

  describe('group-create', () => {
    it('makes an empty group the caller can then file sessions into', async () => {
      const text = await output('group-create', 'release train')
      expect(text).toContain('release train')

      const rows = await listWorktreeGroupRows('proj')
      expect(rows).toHaveLength(1)
      // Pinned, or a memberless group would be listed by nothing.
      expect(rows[0]).toMatchObject({ name: 'release train', pinned: true })
    })

    it('is idempotent, so an agent can name a group without checking first', async () => {
      await output('group-create', 'review')
      await output('group-create', 'review')
      expect(await listWorktreeGroupRows('proj')).toHaveLength(1)
    })

    it('refuses a blank name', async () => {
      const outcome = await run('group-create', '   ')
      expect(outcome).toEqual({ ok: false, error: 'group name must not be empty' })
      expect(await listWorktreeGroupRows('proj')).toEqual([])
    })
  })

  describe('group-move', () => {
    beforeEach(async () => {
      await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'aaaabbbb-1111-2222' })
    })

    const groupOf = async (id: string, slug = 'proj'): Promise<string | undefined> =>
      (await getProjectWorktreeRows(slug)).get(id)?.groupId

    it('files a session by short id prefix, creating the group', async () => {
      const text = await output('group-move', 'release', { session: 'aaaabbbb' })
      expect(text).toContain('into "release"')

      const rows = await listWorktreeGroupRows('proj')
      expect(await groupOf('aaaabbbb-1111-2222')).toBe(rows[0].groupId)
    })

    it('returns a session to the default list on "--"', async () => {
      await output('group-move', 'release', { session: 'aaaabbbb' })
      const text = await output('group-move', '--', { session: 'aaaabbbb' })

      expect(text).toContain('out of its group')
      expect(await groupOf('aaaabbbb-1111-2222')).toBeUndefined()
      // The group itself survives its last member leaving.
      expect(await listWorktreeGroupRows('proj')).toHaveLength(1)
    })

    it('cannot move another project\'s session', async () => {
      await recordWorktreeCreated({ projectSlug: 'other', worktreeId: 'foreign-session' })

      const outcome = await run('group-move', 'release', { session: 'foreign-session' })

      expect(outcome.ok).toBe(false)
      expect(await groupOf('foreign-session', 'other')).toBeUndefined()
    })

    it('refuses an ambiguous prefix rather than moving the wrong session', async () => {
      await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'aaaabbbb-3333-4444' })
      const outcome = await run('group-move', 'release', { session: 'aaaabbbb' })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error).toContain('no session')
    })

    it('needs a session to move', async () => {
      const outcome = await run('group-move', 'release')
      expect(outcome).toEqual({ ok: false, error: 'group move needs a session id' })
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
    worktreeId: workspaceId,
    projectSlug,
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 1_760_000_000_000,
    labels: {},
  }
}
