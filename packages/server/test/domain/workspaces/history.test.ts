import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { recordConversations } from '#db/conversation-store'
import { closeDb } from '#db/client'
import { listWorkspaceConversations } from '#db'
import {
  acpLogDir,
  agentHistoryDir,
  claudeDir,
  claudeProjectDirName,
  codexDir,
  projectDir,
  workspaceDir,
} from '@yaac/shared/project-paths'
import { convergeAgentHistory, removeAgentHistory } from '#domain/workspaces'

/**
 * Both directions of the converge run for real against a planted layout: the
 * point is where every file ends up, so nothing here is mocked — the disk is
 * the outside world this feature hands its result to.
 */

const SLUG = '7d4e2a1c-5b3f-4e8a-9c6d-1f2e3a4b5c6d'
const WT = 'wt-a'
const SIBLING = 'wt-b'
/** One repo, the project's own, checked out at the workspace root. */
const FLAT = [{ cwd: '', repoId: SLUG }]
/** Two other repos, each in a folder, under a root that is no checkout. */
const API = '11111111-2222-4333-8444-555555555555'
const WEB = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const NESTED = [{ cwd: '' }, { cwd: 'api', repoId: API }, { cwd: 'web', repoId: WEB }]

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await recordWorkspaceCreated({ projectId: SLUG, workspaceId: WT })
  await recordWorkspaceCreated({ projectId: SLUG, workspaceId: SIBLING })
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
  it('moves every conversation the workspace held out of the shared homes, under a runtime that cannot layer', async () => {
    const projects = shared('claude', 'projects', '-workspace')
    // Rows: an active claude conversation with its path, an inactive one
    // without, and a codex thread.
    await recordConversations(SLUG, WT, [
      { tool: 'claude', conversationId: 'c1', transcriptPath: 'claude/projects/-workspace/c1.jsonl' },
      { tool: 'claude', conversationId: 'c2' },
      { tool: 'codex', conversationId: 't1', transcriptPath: `codex/sessions/${ROLLOUT_REL('t1')}` },
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
    // A sibling's conversations stay.
    await write(path.join(projects, 's1.jsonl'))
    await rollout(shared('codex', 'sessions'), 'tx')
    await recordConversations(SLUG, SIBLING, [
      { tool: 'claude', conversationId: 's1' },
      { tool: 'codex', conversationId: 'tx', transcriptPath: `codex/sessions/${ROLLOUT_REL('tx')}` },
    ])
    const elsewhere = await write(path.join(tmpDir, 'elsewhere.jsonl'))
    await fs.symlink(elsewhere, path.join(projects, 'c2.jsonl'))
    // A name already taken in the history is never overwritten.
    await write(history('claude', '-workspace', 'a1.jsonl'), 'kept\n')

    await convergeAgentHistory(SLUG, WT, FLAT, { layers: false })

    for (const moved of [
      history('claude', '-workspace', 'c1.jsonl'),
      history('claude', '-workspace', 'c1', 'subagents', 'agent-x.jsonl'),
      history('claude', '-workspace', 'c2.jsonl'),
      history('claude', '-workspace', `${WT}.jsonl`),
      history('claude-file-history', 'c1', 'edit@v1'),
      history('codex', ROLLOUT_REL('t1')),
      history('codex', ROLLOUT_REL('t2')),
      history('codex', ROLLOUT_REL('t3')),
    ]) expect(await exists(moved), moved).toBe(true)
    for (const stayed of [
      path.join(projects, 's1.jsonl'),
      shared('codex', 'sessions', ROLLOUT_REL('tx')),
      path.join(projects, 'a1.jsonl'),
      shared('codex', 'sessions', ROLLOUT_REL('u1')),
    ]) expect(await exists(stayed), stayed).toBe(true)
    expect(await fs.readFile(history('claude', '-workspace', 'a1.jsonl'), 'utf8')).toBe('kept\n')
    expect((await fs.lstat(path.join(projects, 'c2.jsonl'))).isSymbolicLink()).toBe(true)
    expect(await exists(path.join(projects, 'c1.jsonl'))).toBe(false)

    // The rows follow the files.
    const rows = await listWorkspaceConversations(SLUG, WT)
    expect(rows.find((r) => r.conversationId === 'c1')?.transcriptPath)
      .toBe(path.join('history', WT, 'claude', '-workspace', 'c1.jsonl'))
    expect(rows.find((r) => r.conversationId === 't1')?.transcriptPath)
      .toBe(path.join('history', WT, 'codex', ROLLOUT_REL('t1')))

    // A second pass finds nothing left to do.
    await convergeAgentHistory(SLUG, WT, FLAT, { layers: false })
    expect(await exists(history('claude', '-workspace', 'c1.jsonl'))).toBe(true)
  })

  // A pod writes its history through the mounts, so a layering runtime
  // needs only the mount sources, which the kubelet would otherwise create
  // root-owned.
  it('creates every mount source and nested mountpoint, and moves nothing, under a runtime that layers', async () => {
    const left = await write(shared('claude', 'projects', '-workspace', `${WT}.jsonl`))

    await convergeAgentHistory(SLUG, WT, FLAT, { layers: true })

    for (const dir of [
      history('codex-sqlite'),
      history('claude', '-workspace', 'memory'),
      shared('claude', 'projects', `-repo-${SLUG}`, 'memory'),
      shared('claude', 'file-history'),
      shared('codex', 'sessions'),
    ]) expect(await exists(dir), dir).toBe(true)
    expect(await exists(left)).toBe(true)
  })

  it('repoints a row whose file an interrupted pass already moved', async () => {
    // The rename landed, the row write did not: the file is in the history
    // and the row still names the shared home.
    await recordConversations(SLUG, WT, [
      { tool: 'claude', conversationId: 'y1', transcriptPath: 'claude/projects/-workspace/y1.jsonl' },
    ])
    await write(history('claude', '-workspace', 'y1.jsonl'))

    await convergeAgentHistory(SLUG, WT, FLAT, { layers: false })

    const rows = await listWorkspaceConversations(SLUG, WT)
    expect(rows.map((r) => r.transcriptPath)).toEqual([
      path.join('history', WT, 'claude', '-workspace', 'y1.jsonl'),
    ])
  })

  it('links the shared homes into the history, under a runtime that cannot layer', async () => {
    const projects = shared('claude', 'projects')
    const checkout = path.join(projects, claudeProjectDirName(workspaceDir(SLUG, WT)))
    // What a pod wrote into the history, to resume here.
    await write(history('claude', '-workspace', 'k1.jsonl'))
    await write(history('claude-file-history', 'k1', 'edit@v1'))
    await rollout(history('codex'), 'kt')
    // What an earlier host run left in a real folder for this checkout.
    await write(path.join(checkout, 'h1.jsonl'))
    await recordConversations(SLUG, WT, [
      { tool: 'claude', conversationId: 'h1', transcriptPath: path.relative(projectDir(SLUG), path.join(checkout, 'h1.jsonl')) },
    ])
    // The project's shared memory.
    await write(path.join(projects, `-repo-${SLUG}`, 'memory', 'MEMORY.md'), 'remember\n')

    await convergeAgentHistory(SLUG, WT, FLAT, { layers: false })

    // The checkout's folder now IS the history's, earlier host files and all.
    expect((await fs.lstat(checkout)).isSymbolicLink()).toBe(true)
    expect(await fs.realpath(path.join(checkout, 'k1.jsonl'))).toBe(await fs.realpath(history('claude', '-workspace', 'k1.jsonl')))
    expect(await exists(history('claude', '-workspace', 'h1.jsonl'))).toBe(true)
    expect((await listWorkspaceConversations(SLUG, WT))[0]?.transcriptPath)
      .toBe(path.join('history', WT, 'claude', '-workspace', 'h1.jsonl'))
    // Memory is the project's shared one, reached from the checkout's own
    // memory folder, which is where claude looks for it (the checkout is
    // its own git root).
    expect(await fs.readFile(path.join(checkout, 'memory', 'MEMORY.md'), 'utf8')).toBe('remember\n')
    // Each file-history dir and rollout at the path its tool looks for it.
    expect(await fs.readFile(shared('claude', 'file-history', 'k1', 'edit@v1'), 'utf8')).toBe('{}\n')
    expect((await fs.lstat(shared('codex', 'sessions', ROLLOUT_REL('kt')))).isSymbolicLink()).toBe(true)

    // Idempotent, and a link someone re-pointed is put back.
    await fs.unlink(checkout)
    await fs.symlink(tmpDir, checkout)
    await convergeAgentHistory(SLUG, WT, FLAT, { layers: false })
    expect(await fs.realpath(checkout)).toBe(await fs.realpath(history('claude', '-workspace')))
  })

  it('creates a claude folder and a memory mount per cwd, under a runtime that layers', async () => {
    await convergeAgentHistory(SLUG, WT, NESTED, { layers: true })

    for (const dir of [
      history('claude', '-workspace', 'memory'),
      history('claude', '-workspace-api', 'memory'),
      history('claude', '-workspace-web', 'memory'),
      shared('claude', 'projects', '-workspace-root', 'memory'),
      shared('claude', 'projects', `-repo-${API}`, 'memory'),
      shared('claude', 'projects', `-repo-${WEB}`, 'memory'),
    ]) expect(await exists(dir), dir).toBe(true)
  })

  it('files each conversation under the cwd it ran in, and links each cwd to its memory, under a runtime that cannot layer', async () => {
    const projects = shared('claude', 'projects')
    const folder = (cwd: string): string => path.join(projects, claudeProjectDirName(path.join(workspaceDir(SLUG, WT), cwd)))
    // What host runs left in real folders: one in `web`, one at the root,
    // and one under a directory that is no cwd of the workspace.
    await recordConversations(SLUG, WT, [
      { tool: 'claude', conversationId: 'w1', transcriptPath: path.relative(projectDir(SLUG), path.join(folder('web'), 'w1.jsonl')) },
      { tool: 'claude', conversationId: 'r1' },
      { tool: 'claude', conversationId: 'd1' },
    ])
    await write(path.join(folder('web'), 'w1.jsonl'))
    await write(path.join(folder(''), 'r1.jsonl'))
    await write(path.join(folder('web/src'), 'd1.jsonl'))
    await write(path.join(projects, `-repo-${WEB}`, 'memory', 'MEMORY.md'), 'web\n')
    await write(path.join(projects, '-workspace-root', 'memory', 'MEMORY.md'), 'root\n')

    await convergeAgentHistory(SLUG, WT, NESTED, { layers: false })

    for (const moved of [
      history('claude', '-workspace-web', 'w1.jsonl'),
      history('claude', '-workspace', 'r1.jsonl'),
      history('claude', '-workspace', 'd1.jsonl'),
    ]) expect(await exists(moved), moved).toBe(true)
    expect((await listWorkspaceConversations(SLUG, WT)).find((r) => r.conversationId === 'w1')?.transcriptPath)
      .toBe(path.join('history', WT, 'claude', '-workspace-web', 'w1.jsonl'))
    // Each cwd's folder is the history's, and its memory the one for it.
    for (const cwd of ['', 'api', 'web']) expect((await fs.lstat(folder(cwd))).isSymbolicLink(), cwd).toBe(true)
    expect(await fs.readFile(path.join(folder('web'), 'memory', 'MEMORY.md'), 'utf8')).toBe('web\n')
    expect(await fs.readFile(path.join(folder(''), 'memory', 'MEMORY.md'), 'utf8')).toBe('root\n')

    await removeAgentHistory(SLUG, WT)
    for (const cwd of ['', 'api', 'web']) expect(await exists(folder(cwd)), cwd).toBe(false)
    expect(await exists(path.join(projects, `-repo-${WEB}`, 'memory', 'MEMORY.md'))).toBe(true)
  })
})

describe('removeAgentHistory', () => {
  it('takes the history and every link into it, and nothing else', async () => {
    await write(history('claude-file-history', 'k1', 'edit@v1'))
    await write(history('claude-file-history', 'k2', 'edit@v1'))
    await rollout(history('codex'), 'kt')
    await write(history('claude', '-workspace', 'k1.jsonl'))
    const sibling = await write(shared('codex', 'sessions', 'theirs.jsonl'))
    // claude's per-conversation env dirs: the pinned first conversation's,
    // one with a transcript in the history, and a sibling's.
    for (const sid of [WT, 'k1', 'theirs']) await fs.mkdir(shared('claude', 'session-env', sid), { recursive: true })
    await convergeAgentHistory(SLUG, WT, FLAT, { layers: false })
    const checkout = path.join(shared('claude', 'projects'), claudeProjectDirName(workspaceDir(SLUG, WT)))
    expect(await exists(checkout)).toBe(true)
    // A name another workspace's history has since taken over is its link now.
    const retargeted = shared('claude', 'file-history', 'k2')
    await fs.unlink(retargeted)
    await fs.symlink(path.join(agentHistoryDir(SLUG, SIBLING), 'claude-file-history', 'k2'), retargeted)

    await removeAgentHistory(SLUG, WT)

    for (const gone of [
      agentHistoryDir(SLUG, WT),
      checkout,
      shared('claude', 'file-history', 'k1'),
      shared('codex', 'sessions', ROLLOUT_REL('kt')),
      shared('claude', 'session-env', WT),
      shared('claude', 'session-env', 'k1'),
    ]) expect(await exists(gone), gone).toBe(false)
    expect(await exists(sibling)).toBe(true)
    expect(await exists(shared('claude', 'session-env', 'theirs'))).toBe(true)
    expect((await fs.lstat(retargeted)).isSymbolicLink()).toBe(true)
    // Nothing there is no error.
    await removeAgentHistory(SLUG, WT)
    expect(await exists(claudeDir(SLUG))).toBe(true)
    expect(await exists(codexDir(SLUG))).toBe(true)
  })
})
