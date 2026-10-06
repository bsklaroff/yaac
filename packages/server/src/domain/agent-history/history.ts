import fs from 'node:fs/promises'
import path from 'node:path'
import {
  acpLogDir,
  AGENT_HISTORY_PARTS,
  agentHistoryDir,
  claudeDir,
  codexDir,
  projectDir,
  workspaceDir,
} from '@yaac/shared/project-paths'
import { agentSessionIdSchema } from '@yaac/shared/types'
import { openRoot, type ConfinedRoot } from '#lib/confined-fs'
import {
  applyWorkspaceEvent,
  getProjectAgentSessions,
  listProjectWorkspaceIds,
  listWorkspaceAgentSessions,
  type AgentSessionLinkRow,
} from '#db'
import {
  CLAUDE_POD_CWD,
  CLAUDE_POD_REPO,
  claudeProjectDirName,
  codexRolloutParent,
  codexRolloutThreadId,
} from '#runtime/agents'
import { serverLog } from '#log'

/**
 * Prepare a workspace's agent history before launch
 * (docs/workspace-storage.md).
 *
 * A runtime that `layers` mounts over the tool homes (k8s) only needs the
 * mount sources: its pods write their history through those mounts, never
 * into the shared homes. Creating them must succeed, since the kubelet would
 * create a missing mount source root-owned.
 *
 * A runtime that can't layer mounts (containerless) has every conversation
 * the workspace owns moved out of the project's shared tool homes into its
 * own `history/`, then gets symlinks in the shared homes pointing into it:
 * claude's folder for this checkout, the memory folder, and each
 * file-history dir and codex rollout. Files a host run writes outside those
 * links are moved in at the next create. The moves are best-effort.
 */
export async function convergeAgentHistory(
  projectId: string,
  workspaceId: string,
  runtime: { layers: boolean },
): Promise<void> {
  const history = agentHistoryDir(projectId, workspaceId)
  await Promise.all(AGENT_HISTORY_PARTS.map((part) => fs.mkdir(path.join(history, part), { recursive: true })))
  await fs.mkdir(path.join(history, 'claude', CLAUDE_POD_CWD), { recursive: true })
  if (runtime.layers) {
    // The memory mount source and every nested mountpoint.
    await fs.mkdir(path.join(claudeDir(projectId), 'projects', CLAUDE_POD_REPO, 'memory'), { recursive: true })
    await fs.mkdir(path.join(history, 'claude', CLAUDE_POD_CWD, 'memory'), { recursive: true })
    await fs.mkdir(path.join(claudeDir(projectId), 'file-history'), { recursive: true })
    await fs.mkdir(path.join(codexDir(projectId), 'sessions'), { recursive: true })
    return
  }

  const rows = await listWorkspaceAgentSessions(projectId, workspaceId)
  const shared = await siblingConversations(projectId, workspaceId)
  const ids = await conversationIds(projectId, workspaceId, rows, shared)
  for (const step of [
    () => moveClaude(projectId, history, ids),
    () => moveCodex(projectId, history, ids, shared, rows),
    () => linkOut(projectId, workspaceId, history, shared),
  ]) {
    await step().catch((err: unknown) => {
      serverLog(`[agent-history] ${projectId}/${workspaceId}: ${String(err)}`)
    })
  }
  await repointRows(projectId, workspaceId, rows.filter((r) => !shared.has(r.agentSessionId)))
}

/**
 * Update the transcript path of each row whose file has moved from the shared
 * home into the history (the caller excludes rows a sibling shares). Checks
 * the disk rather than this pass's moves, so an interrupted converge is
 * repaired next time. The shared home is checked `no-links`, since through
 * the links into the history every moved file would look unmoved.
 */
async function repointRows(projectId: string, workspaceId: string, rows: AgentSessionLinkRow[]): Promise<void> {
  const project = projectDir(projectId)
  const sessions = []
  for (const r of rows) {
    const stored = r.transcriptPath
    const to = stored === undefined ? undefined : historyDestination(workspaceId, stored)
    if (stored === undefined || to === undefined) continue
    const [tool, ...rel] = stored.split('/')
    const home = await openRoot(path.join(project, tool), 'no-links').catch(() => null)
    if (home !== null && await home.stat(rel.join('/')) !== null) continue
    if (!await fs.lstat(path.join(project, to)).then(() => true, () => false)) continue
    sessions.push({ tool: r.tool, agentSessionId: r.agentSessionId, transcriptPath: to })
  }
  if (sessions.length > 0) {
    await applyWorkspaceEvent({ type: 'sessions-discovered', projectId, workspaceId, sessions })
  }
}

/** The project-relative history path a shared-home path moves to, or
 *  undefined if converge doesn't move it. */
function historyDestination(workspaceId: string, stored: string): string | undefined {
  const [tool, sub, ...rest] = stored.split('/')
  const into = (part: string, ...tail: string[]): string => path.join('history', workspaceId, part, ...tail)
  if (tool === 'claude' && sub === 'projects' && rest.length >= 2) return into('claude', CLAUDE_POD_CWD, ...rest.slice(1))
  if (tool === 'codex' && sub === 'sessions' && rest.length >= 1) return into('codex', ...rest)
  return undefined
}

/**
 * Delete a workspace's history and the links into it from the shared homes,
 * which would otherwise dangle. Only for a workspace being removed; a stop
 * keeps everything.
 */
export async function removeAgentHistory(projectId: string, workspaceId: string): Promise<void> {
  const history = agentHistoryDir(projectId, workspaceId)
  const links = [
    ...(await checkoutForms(projectId, workspaceId))
      .map((form) => path.join(claudeDir(projectId), 'projects', claudeProjectDirName(form))),
    ...(await fs.readdir(path.join(history, 'claude-file-history')).catch(() => []))
      .map((sid) => path.join(claudeDir(projectId), 'file-history', sid)),
    ...(await filesUnder(path.join(history, 'codex')))
      .map((rel) => path.join(codexDir(projectId), 'sessions', rel)),
  ]
  // Only remove links that still point into this history.
  for (const link of links) {
    const to = await fs.readlink(link).catch(() => null)
    if (to !== null && path.resolve(path.dirname(link), to).startsWith(`${history}${path.sep}`)) await fs.unlink(link)
  }
  await fs.rm(history, { recursive: true, force: true })
}

/**
 * Move `rel` under a shared home to `dest` in the history. The home is opened
 * `no-links` because a pod may have written there: a symlink along the path
 * is refused and one at the leaf is left alone. Never overwrites; a taken
 * destination is logged and skipped.
 */
async function moveIn(home: ConfinedRoot, rel: string, dest: string): Promise<void> {
  const at = await home.parent(rel).catch(() => null)
  if (at === null) return
  try {
    const source = at.dir.child(at.name)
    const stat = await fs.lstat(source).catch(() => null)
    if (stat === null || stat.isSymbolicLink()) return
    if (await fs.lstat(dest).then(() => true, () => false)) {
      serverLog(`[agent-history] ${path.join(home.real, rel)}: ${dest} is taken; left in place`)
      return
    }
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.rename(source, dest)
  } finally {
    await at.dir.close()
  }
}

/**
 * Conversations linked to a sibling workspace. A conversation linked to two
 * workspaces has no single owner, so it stays in the shared home (readable by
 * both, though neither's pod can resume it) rather than going to whichever
 * converges first.
 */
async function siblingConversations(projectId: string, workspaceId: string): Promise<Set<string>> {
  const siblings = [...(await listProjectWorkspaceIds(projectId)).keys()].filter((id) => id !== workspaceId)
  const links = await getProjectAgentSessions(projectId, siblings)
  return new Set([...links.values()].flat().map((r) => r.agentSessionId))
}

/**
 * This workspace's conversation ids: every one its rows name, every one acpd
 * recorded (an ACP conversation fires no hook but still writes a transcript),
 * and the workspace id (used by the pinned first conversation). Excludes
 * shared ones and any id failing the id schema, since each becomes a path.
 */
async function conversationIds(
  projectId: string,
  workspaceId: string,
  rows: AgentSessionLinkRow[],
  shared: Set<string>,
): Promise<Set<string>> {
  const records = (await fs.readdir(acpLogDir(projectId, workspaceId)).catch(() => []))
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => name.slice(0, -'.jsonl'.length))
  const ids = [workspaceId, ...rows.map((r) => r.agentSessionId), ...records]
  for (const id of ids.filter((i) => shared.has(i))) {
    serverLog(`[agent-history] ${projectId}/${workspaceId}: ${id} is a sibling's conversation too; left shared`)
  }
  return new Set(ids.filter((id) => !shared.has(id) && agentSessionIdSchema.safeParse(id).success))
}

/**
 * Move claude's files: each conversation's transcript and companion dir (tool
 * results, subagents) from any cwd folder into the history's single folder,
 * plus its file-history (used by `/rewind`).
 */
async function moveClaude(projectId: string, history: string, ids: Set<string>): Promise<void> {
  const home = await openRoot(claudeDir(projectId), 'no-links').catch(() => null)
  if (home === null) return
  const into = path.join(history, 'claude', CLAUDE_POD_CWD)
  for (const cwd of await home.readdir('projects')) {
    if (!cwd.isDirectory()) continue
    for (const id of ids) {
      await moveIn(home, `projects/${cwd.name}/${id}.jsonl`, path.join(into, `${id}.jsonl`))
      await moveIn(home, `projects/${cwd.name}/${id}`, path.join(into, id))
    }
  }
  for (const id of ids) {
    await moveIn(home, `file-history/${id}`, path.join(history, 'claude-file-history', id))
  }
}

/**
 * Move codex's rollouts (matched by the thread id in the name, or by a row's
 * recorded path) to the same relative path under the history's `codex/`.
 *
 * A `spawn_agent` child or fork is its own thread and may be in no row, so
 * the set is extended with any rollout whose parent (first line) is already
 * in it, until nothing is added. Parents come from the rollouts, not codex's
 * sqlite, which may be shared or absent. A thread a sibling's rows name never
 * joins.
 */
async function moveCodex(
  projectId: string,
  history: string,
  ids: Set<string>,
  shared: Set<string>,
  rows: AgentSessionLinkRow[],
): Promise<void> {
  const homeDir = codexDir(projectId)
  const home = await openRoot(homeDir, 'no-links').catch(() => null)
  if (home === null) return
  const rollouts: Array<{ rel: string; thread: string | undefined; parent?: Promise<string | undefined> }> = []
  const walk = async (rel: string, depth: number): Promise<void> => {
    for (const e of await home.readdir(rel)) {
      const child = `${rel}/${e.name}`
      if (e.isFile()) rollouts.push({ rel: child, thread: codexRolloutThreadId(e.name) })
      else if (e.isDirectory() && depth > 0) await walk(child, depth - 1)
    }
  }
  // `sessions/<YYYY>/<MM>/<DD>/`.
  await walk('sessions', 3)

  const threads = new Set(ids)
  const parentOf = (r: typeof rollouts[number]): Promise<string | undefined> => {
    r.parent ??= r.rel.endsWith('.jsonl')
      ? codexRolloutParent({ projectId, dir: homeDir, rel: r.rel })
      : Promise.resolve(undefined)
    return r.parent
  }
  for (let grew = true; grew;) {
    grew = false
    for (const r of rollouts) {
      if (r.thread === undefined || threads.has(r.thread) || shared.has(r.thread)) continue
      const parent = await parentOf(r)
      if (parent !== undefined && threads.has(parent)) {
        threads.add(r.thread)
        grew = true
      }
    }
  }

  const recorded = new Set(rows.flatMap((r) =>
    r.tool === 'codex' && !shared.has(r.agentSessionId) && r.transcriptPath?.startsWith('codex/') === true
      ? [r.transcriptPath.slice('codex/'.length)]
      : []))
  for (const r of rollouts) {
    if ((r.thread === undefined || !threads.has(r.thread)) && !recorded.has(r.rel)) continue
    await moveIn(home, r.rel, path.join(history, 'codex', r.rel.slice('sessions/'.length)))
  }
}

/**
 * Plant symlinks in the shared homes for a host (containerless) workspace,
 * which has no mounts:
 *
 * - claude's folder for this checkout, linked to the history's, so host
 *   conversations are written straight into it. An existing real folder is
 *   first emptied into the history, unless it holds a shared conversation,
 *   in which case it stays real.
 * - the `memory` folder among those conversations, linked to the project's
 *   shared memory (which a pod mounts at the same place), so auto-memory is
 *   shared across drivers and workspaces.
 * - each file-history dir and codex rollout, at the path claude or codex
 *   looks for it.
 *
 * Every spelling of each path gets a link: the data dir as named and as
 * resolved (macOS's `/var` is `/private/var`).
 */
async function linkOut(projectId: string, workspaceId: string, history: string, shared: Set<string>): Promise<void> {
  const projects = path.join(claudeDir(projectId), 'projects')
  const conversations = path.join(history, 'claude', CLAUDE_POD_CWD)
  for (const form of await checkoutForms(projectId, workspaceId)) {
    const link = path.join(projects, claudeProjectDirName(form))
    const stat = await fs.lstat(link).catch(() => null)
    if (stat?.isDirectory() === true) {
      const home = await openRoot(claudeDir(projectId), 'no-links')
      for (const name of await fs.readdir(link)) {
        // A shared conversation stays, so the folder stays real.
        if (shared.has(name.replace(/\.jsonl$/, ''))) continue
        await moveIn(home, `projects/${path.basename(link)}/${name}`, path.join(conversations, name))
      }
      if (!await fs.rmdir(link).then(() => true, () => false)) {
        serverLog(`[agent-history] ${link}: not empty after moving it in; not linked`)
        continue
      }
    }
    await ensureLink(link, conversations)
  }

  // claude keys memory on the git root (the checkout), so its memory folder
  // sits among this workspace's conversations; link it to the shared one. An
  // empty folder is a pod mountpoint left by the other driver.
  await fs.rmdir(path.join(conversations, 'memory')).catch(() => {})
  await ensureLink(path.join(conversations, 'memory'), path.join(projects, CLAUDE_POD_REPO, 'memory'))

  for (const sid of await fs.readdir(path.join(history, 'claude-file-history'))) {
    await ensureLink(
      path.join(claudeDir(projectId), 'file-history', sid),
      path.join(history, 'claude-file-history', sid),
    )
  }
  for (const rel of await filesUnder(path.join(history, 'codex'))) {
    await ensureLink(path.join(codexDir(projectId), 'sessions', rel), path.join(history, 'codex', rel))
  }
}

/** A relative link at `link` to `target`, replacing a link that points
 *  elsewhere; anything real at `link` is logged and kept. */
async function ensureLink(link: string, target: string): Promise<void> {
  const to = path.relative(path.dirname(link), target)
  const stat = await fs.lstat(link).catch(() => null)
  if (stat?.isSymbolicLink() === true) {
    if (await fs.readlink(link) === to) return
    await fs.unlink(link)
  } else if (stat !== null) {
    serverLog(`[agent-history] ${link} exists; not linked to ${target}`)
    return
  }
  await fs.mkdir(path.dirname(link), { recursive: true })
  await fs.symlink(to, link)
}

/** A project path in every spelling a host tool may resolve it to: as the
 *  data dir names it, and through its links. */
async function forms(projectId: string, of: string): Promise<string[]> {
  const project = projectDir(projectId)
  const real = await fs.realpath(project).catch(() => project)
  const rel = path.relative(project, of)
  return [...new Set([of, path.join(real, rel)])]
}

const checkoutForms = (projectId: string, workspaceId: string): Promise<string[]> =>
  forms(projectId, workspaceDir(projectId, workspaceId))

/** Every file below `dir`, relative to it; [] when there is no `dir`. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
}
