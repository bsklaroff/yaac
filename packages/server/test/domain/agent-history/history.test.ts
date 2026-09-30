import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { recordAgentSessions } from '#db/agent-session-store'
import { closeDb } from '#db/client'
import { listWorkspaceAgentSessions } from '#db'
import {
  acpLogDir,
  agentHistoryDir,
  claudeDir,
  codexDir,
  piSessionsDir,
  projectDir,
  repoDir,
  workspaceDir,
} from '@yaac/shared/project-paths'
import { claudeProjectDirName } from '#runtime/agents'
import { convergeAgentHistory, removeAgentHistory } from '#domain/agent-history'

/**
 * Both directions of the converge run for real against a planted layout: the
 * point is where every file ends up, so nothing here is mocked — the disk is
 * the outside world this feature hands its result to.
 */

const SLUG = 'demo'
const WT = 'wt-a'
const SIBLING = 'wt-b'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await recordWorkspaceCreated({ projectSlug: SLUG, workspaceId: WT })
  await recordWorkspaceCreated({ projectSlug: SLUG, workspaceId: SIBLING })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

async function write(file: string, body = '{}\n'): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body)
  return file
}

const exists = (p: string): Promise<boolean> => fs.lstat(p).then(() => true, () => false)
const history = (...rest: string[]): string => path.join(agentHistoryDir(SLUG, WT), ...rest)
const shared = (...rest: string[]): string => path.join(projectDir(SLUG), ...rest)

/** A codex rollout named the way codex names one, its first line naming
 *  the thread it descends from, if any. */
async function rollout(dir: string, thread: string, parent?: string, forkedFrom?: string): Promise<string> {
  const source = parent === undefined ? 'cli' : { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } }
  return write(
    path.join(dir, '2026', '09', '29', `rollout-2026-09-29T08-32-40-${thread}.jsonl`),
    `${JSON.stringify({ type: 'session_meta', payload: { id: thread, source, forked_from_id: forkedFrom } })}\n`,
  )
}

const ROLLOUT_REL = (thread: string): string => `2026/09/29/rollout-2026-09-29T08-32-40-${thread}.jsonl`

describe('convergeAgentHistory', () => {
  it('moves every conversation the workspace held out of the shared homes, under a runtime that layers', async () => {
    const projects = shared('claude', 'projects', '-workspace')
    // Rows: an active claude conversation with its path, an inactive one
    // without, and a codex thread.
    await recordAgentSessions(SLUG, WT, [
      { tool: 'claude', agentSessionId: 'c1', transcriptPath: 'claude/projects/-workspace/c1.jsonl' },
      { tool: 'claude', agentSessionId: 'c2' },
      { tool: 'codex', agentSessionId: 't1', transcriptPath: `codex/sessions/${ROLLOUT_REL('t1')}` },
    ])
    await write(path.join(projects, 'c1.jsonl'))
    await write(path.join(projects, 'c1', 'subagents', 'agent-x.jsonl'))
    await write(shared('claude', 'file-history', 'c1', 'edit@v1'))
    // c2 was filed under a host cwd.
    await write(shared('claude', 'projects', '-host-checkout', 'c2.jsonl'))
    // The pinned first conversation, no row yet; and an ACP one, which fires
    // no hook and is known only by its record.
    await write(path.join(projects, `${WT}.jsonl`))
    await write(path.join(acpLogDir(SLUG, WT), 'a1.jsonl'))
    await write(path.join(projects, 'a1.jsonl'))
    // codex: t1's spawned child and grandchild ride with it; a stranger stays.
    await rollout(shared('codex', 'sessions'), 't1')
    await rollout(shared('codex', 'sessions'), 't2', 't1')
    await rollout(shared('codex', 'sessions'), 't3', 't2')
    await rollout(shared('codex', 'sessions'), 'u1')
    // pi, from before each workspace had its own session dir.
    await write(path.join(piSessionsDir(SLUG), 'nested', `100_${WT}.jsonl`))
    await write(path.join(piSessionsDir(SLUG), '100_other.jsonl'))
    // A sibling's conversation; one both workspaces link (resumed from one in
    // the other, back when the folder was shared); and the sibling's fork of
    // our codex thread. None of them is ours alone.
    await write(path.join(projects, 's1.jsonl'))
    await write(path.join(projects, 'x1.jsonl'))
    await rollout(shared('codex', 'sessions'), 'tx')
    await recordAgentSessions(SLUG, WT, [
      { tool: 'claude', agentSessionId: 'x1' },
      { tool: 'codex', agentSessionId: 'tx', transcriptPath: `codex/sessions/${ROLLOUT_REL('tx')}` },
    ])
    await rollout(shared('codex', 'sessions'), 'tf', undefined, 't1')
    await recordAgentSessions(SLUG, SIBLING, [
      { tool: 'claude', agentSessionId: 's1' },
      { tool: 'claude', agentSessionId: 'x1', transcriptPath: 'claude/projects/-workspace/x1.jsonl' },
      { tool: 'codex', agentSessionId: 'tx', transcriptPath: `codex/sessions/${ROLLOUT_REL('tx')}` },
      { tool: 'codex', agentSessionId: 'tf' },
    ])
    const elsewhere = await write(path.join(tmpDir, 'elsewhere.jsonl'))
    await fs.symlink(elsewhere, path.join(projects, 'c2.jsonl'))
    // A name already taken in the history is never overwritten.
    await write(history('claude', '-workspace', 'a1.jsonl'), 'kept\n')

    await convergeAgentHistory(SLUG, WT, { layers: true })

    for (const moved of [
      history('claude', '-workspace', 'c1.jsonl'),
      history('claude', '-workspace', 'c1', 'subagents', 'agent-x.jsonl'),
      history('claude', '-workspace', 'c2.jsonl'),
      history('claude', '-workspace', `${WT}.jsonl`),
      history('claude-file-history', 'c1', 'edit@v1'),
      history('codex', ROLLOUT_REL('t1')),
      history('codex', ROLLOUT_REL('t2')),
      history('codex', ROLLOUT_REL('t3')),
      history('pi', `100_${WT}.jsonl`),
    ]) expect(await exists(moved), moved).toBe(true)
    for (const stayed of [
      path.join(projects, 's1.jsonl'),
      path.join(projects, 'x1.jsonl'),
      shared('codex', 'sessions', ROLLOUT_REL('tf')),
      shared('codex', 'sessions', ROLLOUT_REL('tx')),
      path.join(projects, 'a1.jsonl'),
      shared('codex', 'sessions', ROLLOUT_REL('u1')),
      path.join(piSessionsDir(SLUG), '100_other.jsonl'),
    ]) expect(await exists(stayed), stayed).toBe(true)
    expect(await fs.readFile(history('claude', '-workspace', 'a1.jsonl'), 'utf8')).toBe('kept\n')
    expect((await fs.lstat(path.join(projects, 'c2.jsonl'))).isSymbolicLink()).toBe(true)
    expect(await exists(path.join(projects, 'c1.jsonl'))).toBe(false)

    // Every mount source and nested mountpoint exists, server-made.
    for (const dir of [
      history('codex-sqlite'),
      history('claude', '-workspace', 'memory'),
      shared('claude', 'projects', '-repo', 'memory'),
      shared('claude', 'file-history'),
      shared('codex', 'sessions'),
    ]) expect(await exists(dir), dir).toBe(true)

    // The rows follow the files.
    const rows = await listWorkspaceAgentSessions(SLUG, WT)
    expect(rows.find((r) => r.agentSessionId === 'c1')?.transcriptPath)
      .toBe(path.join('history', WT, 'claude', '-workspace', 'c1.jsonl'))
    expect(rows.find((r) => r.agentSessionId === 't1')?.transcriptPath)
      .toBe(path.join('history', WT, 'codex', ROLLOUT_REL('t1')))
    expect(rows.find((r) => r.agentSessionId === 'tx')?.transcriptPath)
      .toBe(`codex/sessions/${ROLLOUT_REL('tx')}`)

    // A second pass finds nothing left to do.
    await convergeAgentHistory(SLUG, WT, { layers: true })
    expect(await exists(history('claude', '-workspace', 'c1.jsonl'))).toBe(true)
  })

  it('repoints a row whose file an interrupted pass already moved', async () => {
    // The rename landed, the row write did not: the file is in the history
    // and the row still names the shared home.
    await recordAgentSessions(SLUG, WT, [
      { tool: 'claude', agentSessionId: 'y1', transcriptPath: 'claude/projects/-workspace/y1.jsonl' },
      { tool: 'pi', agentSessionId: 'p1', transcriptPath: 'pi/agent/sessions/nested/100_p1.jsonl' },
    ])
    await write(history('claude', '-workspace', 'y1.jsonl'))
    await write(history('pi', '100_p1.jsonl'))

    await convergeAgentHistory(SLUG, WT, { layers: true })

    const rows = await listWorkspaceAgentSessions(SLUG, WT)
    expect(rows.map((r) => r.transcriptPath)).toEqual([
      path.join('history', WT, 'claude', '-workspace', 'y1.jsonl'),
      path.join('history', WT, 'pi', '100_p1.jsonl'),
    ])
  })

  it('links the shared homes into the history, under a runtime that cannot layer', async () => {
    const projects = shared('claude', 'projects')
    const checkout = path.join(projects, claudeProjectDirName(workspaceDir(SLUG, WT)))
    const repo = path.join(projects, claudeProjectDirName(repoDir(SLUG)))
    // What a pod wrote into the history, to resume here.
    await write(history('claude', '-workspace', 'k1.jsonl'))
    await write(history('claude-file-history', 'k1', 'edit@v1'))
    await rollout(history('codex'), 'kt')
    // What an earlier host run left in a real folder for this checkout.
    await write(path.join(checkout, 'h1.jsonl'))
    await recordAgentSessions(SLUG, WT, [
      { tool: 'claude', agentSessionId: 'h1', transcriptPath: path.relative(projectDir(SLUG), path.join(checkout, 'h1.jsonl')) },
    ])
    // Host memory, keyed on the host repo path.
    await write(path.join(repo, 'memory', 'MEMORY.md'), 'remember\n')

    await convergeAgentHistory(SLUG, WT, { layers: false })

    // The checkout's folder now IS the history's, earlier host files and all.
    expect((await fs.lstat(checkout)).isSymbolicLink()).toBe(true)
    expect(await fs.realpath(path.join(checkout, 'k1.jsonl'))).toBe(await fs.realpath(history('claude', '-workspace', 'k1.jsonl')))
    expect(await exists(history('claude', '-workspace', 'h1.jsonl'))).toBe(true)
    expect((await listWorkspaceAgentSessions(SLUG, WT))[0]?.transcriptPath)
      .toBe(path.join('history', WT, 'claude', '-workspace', 'h1.jsonl'))
    // Memory became the project's shared one, reached from the host name
    // too, and from the checkout's own memory folder, which is where claude
    // looks for it now that the checkout is its own git root.
    expect(await fs.readFile(path.join(projects, '-repo', 'memory', 'MEMORY.md'), 'utf8')).toBe('remember\n')
    expect(await fs.readFile(path.join(repo, 'memory', 'MEMORY.md'), 'utf8')).toBe('remember\n')
    expect(await fs.readFile(path.join(checkout, 'memory', 'MEMORY.md'), 'utf8')).toBe('remember\n')
    // Each file-history dir and rollout at the path its tool looks for it.
    expect(await fs.readFile(shared('claude', 'file-history', 'k1', 'edit@v1'), 'utf8')).toBe('{}\n')
    expect((await fs.lstat(shared('codex', 'sessions', ROLLOUT_REL('kt')))).isSymbolicLink()).toBe(true)

    // Idempotent, and a link someone re-pointed is put back.
    await fs.unlink(checkout)
    await fs.symlink(tmpDir, checkout)
    await convergeAgentHistory(SLUG, WT, { layers: false })
    expect(await fs.realpath(checkout)).toBe(await fs.realpath(history('claude', '-workspace')))
  })

  it('keeps a checkout folder real while it holds a conversation a sibling shares', async () => {
    const checkout = path.join(shared('claude', 'projects'), claudeProjectDirName(workspaceDir(SLUG, WT)))
    const stored = path.relative(projectDir(SLUG), path.join(checkout, 'x1.jsonl'))
    await write(path.join(checkout, 'x1.jsonl'))
    await write(path.join(checkout, 'own.jsonl'))
    await recordAgentSessions(SLUG, WT, [{ tool: 'claude', agentSessionId: 'x1', transcriptPath: stored }])
    await recordAgentSessions(SLUG, SIBLING, [{ tool: 'claude', agentSessionId: 'x1', transcriptPath: stored }])

    await convergeAgentHistory(SLUG, WT, { layers: false })

    expect((await fs.lstat(checkout)).isDirectory()).toBe(true)
    expect(await exists(path.join(checkout, 'x1.jsonl'))).toBe(true)
    expect(await exists(history('claude', '-workspace', 'own.jsonl'))).toBe(true)
    expect((await listWorkspaceAgentSessions(SLUG, WT))[0]?.transcriptPath).toBe(stored)
  })

  it('never merges two real memory folders', async () => {
    const projects = shared('claude', 'projects')
    const repo = path.join(projects, claudeProjectDirName(repoDir(SLUG)))
    await write(path.join(repo, 'memory', 'host.md'))
    await write(path.join(projects, '-repo', 'memory', 'pod.md'))

    await convergeAgentHistory(SLUG, WT, { layers: false })

    expect((await fs.lstat(repo)).isDirectory()).toBe(true)
    expect(await exists(path.join(repo, 'memory', 'host.md'))).toBe(true)
    expect(await exists(path.join(projects, '-repo', 'memory', 'host.md'))).toBe(false)
  })
})

describe('removeAgentHistory', () => {
  it('takes the history and every link into it, and nothing else', async () => {
    await write(history('claude-file-history', 'k1', 'edit@v1'))
    await write(history('claude-file-history', 'k2', 'edit@v1'))
    await rollout(history('codex'), 'kt')
    const sibling = await write(shared('codex', 'sessions', 'theirs.jsonl'))
    await convergeAgentHistory(SLUG, WT, { layers: false })
    const checkout = path.join(shared('claude', 'projects'), claudeProjectDirName(workspaceDir(SLUG, WT)))
    expect(await exists(checkout)).toBe(true)
    // The one an older install's create linked, under its `worktrees/` path.
    const legacy = path.join(shared('claude', 'projects'), claudeProjectDirName(shared('worktrees', WT)))
    await fs.symlink(path.relative(path.dirname(legacy), history('claude', '-workspace')), legacy)
    // A name another workspace's history has since taken over is its link now.
    const retargeted = shared('claude', 'file-history', 'k2')
    await fs.unlink(retargeted)
    await fs.symlink(path.join(agentHistoryDir(SLUG, SIBLING), 'claude-file-history', 'k2'), retargeted)

    await removeAgentHistory(SLUG, WT)

    for (const gone of [
      agentHistoryDir(SLUG, WT),
      checkout,
      legacy,
      shared('claude', 'file-history', 'k1'),
      shared('codex', 'sessions', ROLLOUT_REL('kt')),
    ]) expect(await exists(gone), gone).toBe(false)
    expect(await exists(sibling)).toBe(true)
    expect((await fs.lstat(retargeted)).isSymbolicLink()).toBe(true)
    // Nothing there is no error.
    await removeAgentHistory(SLUG, WT)
    expect(await exists(claudeDir(SLUG))).toBe(true)
    expect(await exists(codexDir(SLUG))).toBe(true)
  })
})
