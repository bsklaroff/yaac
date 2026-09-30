import fs from 'node:fs/promises'
import path from 'node:path'
import {
  acpLogDir,
  AGENT_HISTORY_PARTS,
  agentHistoryDir,
  claudeDir,
  codexDir,
  piDir,
  projectDir,
  repoDir,
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
  sessionIdFromPiLog,
} from '#runtime/agents'
import { serverLog } from '#log'

/**
 * Bring one workspace's agent history into the shape the runtime about to
 * launch it reaches (docs/workspace-storage.md), before it launches.
 *
 * Every conversation the workspace ever held is moved out of the project's
 * shared tool homes into its own `history/` — whatever a pod wrote before
 * the history existed, and whatever a host run left there since. That is
 * the whole of it under a runtime that `layers` mounts over the tool homes:
 * the pod sees its history through those mounts, and nothing else of it.
 *
 * A runtime that cannot layer a mount over a home it links in gets links
 * the other way instead: the folder claude files this checkout's
 * conversations under, the memory folder the host repo path names, and each
 * file-history dir and codex rollout, all pointing into the history, so a
 * conversation written in a pod resumes on the host. What a host run writes
 * outside those links stays in the shared home until the next create moves
 * it in.
 *
 * Permanent rather than a migration: a stretch on either driver can leave
 * files in the shape the other one needs. The directories are made first
 * and that part throws — a pod must never find a mount source missing,
 * which the kubelet would create root-owned. The moves are best-effort,
 * since anything left behind is still read from where it is.
 */
export async function convergeAgentHistory(
  slug: string,
  workspaceId: string,
  runtime: { layers: boolean },
): Promise<void> {
  const history = agentHistoryDir(slug, workspaceId)
  await Promise.all(AGENT_HISTORY_PARTS.map((part) => fs.mkdir(path.join(history, part), { recursive: true })))
  await fs.mkdir(path.join(history, 'claude', CLAUDE_POD_CWD), { recursive: true })
  if (runtime.layers) {
    // The source of the memory mount, and the mountpoints of every mount
    // nested in another — each server-owned rather than left to the kubelet.
    // The memory mountpoint is a link where a host run left one.
    const memoryMount = path.join(history, 'claude', CLAUDE_POD_CWD, 'memory')
    if ((await fs.lstat(memoryMount).catch(() => null))?.isSymbolicLink() === true) await fs.unlink(memoryMount)
    await fs.mkdir(path.join(claudeDir(slug), 'projects', CLAUDE_POD_REPO, 'memory'), { recursive: true })
    await fs.mkdir(memoryMount, { recursive: true })
    await fs.mkdir(path.join(claudeDir(slug), 'file-history'), { recursive: true })
    await fs.mkdir(path.join(codexDir(slug), 'sessions'), { recursive: true })
  }

  const rows = await listWorkspaceAgentSessions(slug, workspaceId)
  const shared = await siblingConversations(slug, workspaceId)
  const ids = await conversationIds(slug, workspaceId, rows, shared)
  for (const step of [
    () => moveClaude(slug, history, ids),
    () => moveCodex(slug, history, ids, shared, rows),
    () => movePi(slug, history, ids),
    ...(runtime.layers ? [] : [() => linkOut(slug, workspaceId, history, shared)]),
  ]) {
    await step().catch((err: unknown) => {
      serverLog(`[agent-history] ${slug}/${workspaceId}: ${String(err)}`)
    })
  }
  await repointRows(slug, workspaceId, rows.filter((r) => !shared.has(r.agentSessionId)))
}

/**
 * Point each row whose file has left the shared home at where it went —
 * never a row a sibling shares, whose one path both workspaces read, read
 * off the disk rather than off this pass's moves — so a converge interrupted
 * between a rename and this write is repaired by the next one. Through the
 * one door for observed facts, like every path the registry records.
 *
 * "Left" is judged `no-links`: a host create's folder link still leads to the
 * file, but a pod's reader, which follows no link, would not.
 */
async function repointRows(slug: string, workspaceId: string, rows: AgentSessionLinkRow[]): Promise<void> {
  const project = projectDir(slug)
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
    await applyWorkspaceEvent({ type: 'sessions-discovered', projectSlug: slug, workspaceId, sessions })
  }
}

/** Where a converge moves the file a shared-home path names, project-relative,
 *  or undefined for a path that is not one it moves. */
function historyDestination(workspaceId: string, stored: string): string | undefined {
  const [tool, sub, ...rest] = stored.split('/')
  const into = (part: string, ...tail: string[]): string => path.join('history', workspaceId, part, ...tail)
  if (tool === 'claude' && sub === 'projects' && rest.length >= 2) return into('claude', CLAUDE_POD_CWD, ...rest.slice(1))
  if (tool === 'codex' && sub === 'sessions' && rest.length >= 1) return into('codex', ...rest)
  if (tool === 'pi' && sub === 'agent' && rest[0] === 'sessions' && rest.length >= 2) return into('pi', rest[rest.length - 1])
  return undefined
}

/**
 * Everything `convergeAgentHistory` made for a workspace: its history, and
 * the links a host create planted in the shared homes pointing into it —
 * left behind, each would dangle in a directory every other workspace's
 * agent lists. Only for a workspace that is going away; a stop keeps it all.
 */
export async function removeAgentHistory(slug: string, workspaceId: string): Promise<void> {
  const history = agentHistoryDir(slug, workspaceId)
  const links = [
    // With the spelling of a checkout an older install made, whose create
    // linked the folder its path named (docs/legacy-compat-shims.md).
    ...[
      ...await checkoutForms(slug, workspaceId),
      ...await forms(slug, path.join(projectDir(slug), 'worktrees', workspaceId)),
    ].map((form) => path.join(claudeDir(slug), 'projects', claudeProjectDirName(form))),
    ...(await fs.readdir(path.join(history, 'claude-file-history')).catch(() => []))
      .map((sid) => path.join(claudeDir(slug), 'file-history', sid)),
    ...(await filesUnder(path.join(history, 'codex')))
      .map((rel) => path.join(codexDir(slug), 'sessions', rel)),
  ]
  // Only a link that still leads into this history: the same name may since
  // have been linked to another workspace's.
  for (const link of links) {
    const to = await fs.readlink(link).catch(() => null)
    if (to !== null && path.resolve(path.dirname(link), to).startsWith(`${history}${path.sep}`)) await fs.unlink(link)
  }
  await fs.rm(history, { recursive: true, force: true })
}

/**
 * Move `rel` under a shared home into the history at `dest`. The home is
 * opened `no-links`: a pod that predates the history could still write
 * there, and a link it planted on the way is refused rather than followed,
 * while one at the leaf is left where it is. Nor is anything overwritten —
 * a name already taken in the history is logged and left.
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
 * The conversations a sibling workspace's rows name. A conversation linked to
 * two workspaces — one resumed from another's under the shared home, before
 * each had its own — has no single owner, so no converge moves it: it stays
 * in the shared home, readable by both, and a pod of either can no longer
 * resume it. Moving it would hand it to whichever converged first and take
 * it from the other.
 */
async function siblingConversations(slug: string, workspaceId: string): Promise<Set<string>> {
  const siblings = [...(await listProjectWorkspaceIds(slug)).keys()].filter((id) => id !== workspaceId)
  const links = await getProjectAgentSessions(slug, siblings)
  return new Set([...links.values()].flat().map((r) => r.agentSessionId))
}

/**
 * The conversations that are this workspace's: every one its rows name (not
 * only the active ones), every one acpd kept a record of — an ACP
 * conversation fires no hook, yet the SDK's claude still writes a
 * transcript — and the workspace id, which the pinned first conversation uses
 * before any row names it. Held to the id schema, since each is joined into
 * a path. Less any a sibling's rows name too (`siblingConversations`).
 */
async function conversationIds(
  slug: string,
  workspaceId: string,
  rows: AgentSessionLinkRow[],
  shared: Set<string>,
): Promise<Set<string>> {
  const records = (await fs.readdir(acpLogDir(slug, workspaceId)).catch(() => []))
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => name.slice(0, -'.jsonl'.length))
  const ids = [workspaceId, ...rows.map((r) => r.agentSessionId), ...records]
  for (const id of ids.filter((i) => shared.has(i))) {
    serverLog(`[agent-history] ${slug}/${workspaceId}: ${id} is a sibling's conversation too; left shared`)
  }
  return new Set(ids.filter((id) => !shared.has(id) && agentSessionIdSchema.safeParse(id).success))
}

/**
 * claude's: each conversation's transcript and its sibling dir (tool
 * results, and the subagents a conversation files inside itself) from
 * whichever cwd folder holds them, into the history's one folder; and its
 * file-history, which `/rewind` restores from.
 */
async function moveClaude(slug: string, history: string, ids: Set<string>): Promise<void> {
  const home = await openRoot(claudeDir(slug), 'no-links').catch(() => null)
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
 * codex's rollouts, found by the thread id in each name or by the path a row
 * recorded, and moved to the same place under the history's `codex/`.
 *
 * A `spawn_agent` child or a fork is a thread of its own, which may never
 * have fired a hook — so it may be in no row. The set closes over them: a
 * rollout whose first line names a thread already in it joins, until nothing
 * new does. Read off the rollouts rather than codex's sqlite, which may be
 * the shared one from before the history, or absent. A thread a sibling's
 * rows name never joins: a host codex can fork any thread linked into the
 * shared home, and that fork is the sibling's.
 */
async function moveCodex(
  slug: string,
  history: string,
  ids: Set<string>,
  shared: Set<string>,
  rows: AgentSessionLinkRow[],
): Promise<void> {
  const homeDir = codexDir(slug)
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
      ? codexRolloutParent({ slug, dir: homeDir, rel: r.rel })
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
 * pi's logs, from the shared session dir it wrote to before each workspace
 * had its own (docs/legacy-compat-shims.md). pi names each for its
 * conversation, and nests some one folder down.
 */
async function movePi(slug: string, history: string, ids: Set<string>): Promise<void> {
  const home = await openRoot(piDir(slug), 'no-links').catch(() => null)
  if (home === null) return
  const walk = async (rel: string, depth: number): Promise<void> => {
    for (const e of await home.readdir(rel)) {
      const child = `${rel}/${e.name}`
      const id = e.isFile() ? sessionIdFromPiLog(e.name) : undefined
      if (id !== undefined && ids.has(id)) await moveIn(home, child, path.join(history, 'pi', e.name))
      else if (e.isDirectory() && depth > 0) await walk(child, depth - 1)
    }
  }
  await walk('agent/sessions', 1)
}

/**
 * The links a host workspace reaches its history through, planted in the
 * shared homes (it has no mount to layer over them):
 *
 * - the folder claude files this checkout's conversations under, linked to
 *   the history's — so a host conversation is written straight into it. A
 *   real folder already there is emptied into the history first, unless it
 *   holds a conversation a sibling links too, which keeps it real.
 * - the `memory` folder among those conversations, linked to the project's
 *   shared memory, which a pod mounts at the same place — claude keys
 *   memory on the checkout's git root, the checkout itself — so auto-memory
 *   is one thing on both drivers and across workspaces. The folder the host
 *   repo path names, where memory lived while checkouts were linked, is
 *   folded into the shared one. Two real folders are both left alone;
 *   memory is never merged.
 * - each file-history dir and codex rollout in the history, at the path
 *   claude or codex looks for it by. A new one a host run writes is a real
 *   file in the shared home until the next create moves it in.
 *
 * Every spelling of each path claude might file under gets a link — the
 * data dir as named, and as resolved (macOS's `/var` is `/private/var`).
 */
async function linkOut(slug: string, workspaceId: string, history: string, shared: Set<string>): Promise<void> {
  const projects = path.join(claudeDir(slug), 'projects')
  const conversations = path.join(history, 'claude', CLAUDE_POD_CWD)
  for (const form of await checkoutForms(slug, workspaceId)) {
    const link = path.join(projects, claudeProjectDirName(form))
    const stat = await fs.lstat(link).catch(() => null)
    if (stat?.isDirectory() === true) {
      const home = await openRoot(claudeDir(slug), 'no-links')
      for (const name of await fs.readdir(link)) {
        // A conversation a sibling links too stays, and so the folder stays
        // real and unlinked (`siblingConversations`).
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

  // claude keys memory on the checkout's git root, which is the checkout
  // itself: its memory folder sits among this workspace's conversations, and
  // is linked back to the project's shared one. An empty one is the pod's
  // mountpoint, left by a run under the other driver.
  const memory = path.join(projects, CLAUDE_POD_REPO)
  await fs.rmdir(path.join(conversations, 'memory')).catch(() => {})
  await ensureLink(path.join(conversations, 'memory'), path.join(memory, 'memory'))
  for (const form of await repoForms(slug)) {
    const name = claudeProjectDirName(form)
    if (name === CLAUDE_POD_REPO) continue
    const link = path.join(projects, name)
    if ((await fs.lstat(link).catch(() => null))?.isDirectory() === true) {
      if (await fs.lstat(memory).then(() => true, () => false)) {
        serverLog(`[agent-history] ${link} and ${memory} both hold memory; left both`)
        continue
      }
      await fs.rename(link, memory)
    }
    await fs.mkdir(memory, { recursive: true })
    await ensureLink(link, memory)
  }

  for (const sid of await fs.readdir(path.join(history, 'claude-file-history'))) {
    await ensureLink(
      path.join(claudeDir(slug), 'file-history', sid),
      path.join(history, 'claude-file-history', sid),
    )
  }
  for (const rel of await filesUnder(path.join(history, 'codex'))) {
    await ensureLink(path.join(codexDir(slug), 'sessions', rel), path.join(history, 'codex', rel))
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
async function forms(slug: string, of: string): Promise<string[]> {
  const project = projectDir(slug)
  const real = await fs.realpath(project).catch(() => project)
  const rel = path.relative(project, of)
  return [...new Set([of, path.join(real, rel)])]
}

const checkoutForms = (slug: string, workspaceId: string): Promise<string[]> =>
  forms(slug, workspaceDir(slug, workspaceId))
const repoForms = (slug: string): Promise<string[]> => forms(slug, repoDir(slug))

/** Every file below `dir`, relative to it; [] when there is no `dir`. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
}
