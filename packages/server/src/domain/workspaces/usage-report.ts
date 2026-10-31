import {
  conversationTitle,
  findWorkspaceRow,
  getProjectConversations,
  listProjectRows,
  listUsers,
  type WorkspaceRow,
} from '#db'
import { workspaceDriver } from '#drivers/driver'
import { usageHistory } from '#runtime/usage'
import type { ResourceReport, UsagePoint, WorkspaceUsageRow } from '@yaac/shared/types'

/**
 * The server health report (docs/server-health.md): the driver's full
 * live usage, joined with the sampler's history and with what only
 * the rows know (workspace titles, project names, owners, and why a stopped
 * workspace died). A workspace that stopped within the hour keeps its row,
 * with its history, so the overlay can show what it did before an eviction
 * or OOM kill.
 */
export async function serverUsageReport(): Promise<ResourceReport> {
  const [usage, projects, users] = await Promise.all([
    workspaceDriver().resourceUsage({ full: true }),
    listProjectRows(),
    listUsers(),
  ])
  const sampledAt = Date.now()
  const history = usageHistory()
  const projectById = new Map(projects.map((p) => [p.id, p]))
  const userName = new Map(users.map((u) => [u.id, u.name]))

  const ids = [...new Set([...Object.keys(usage.workspaces), ...history.workspaces.keys()])]
  const rows = (await Promise.all(ids.map((id) => findWorkspaceRow(id))))
    .filter((r): r is WorkspaceRow => r !== undefined)
  const rowById = new Map(rows.map((r) => [r.workspaceId, r]))
  const titles = new Map<string, string>()
  for (const projectId of new Set(rows.map((r) => r.projectId))) {
    const ofProject = rows.filter((r) => r.projectId === projectId)
    const links = await getProjectConversations(projectId, ofProject.map((r) => r.workspaceId))
    for (const r of ofProject) {
      const title = r.title ?? conversationTitle(links.get(r.workspaceId) ?? []) ?? r.generatedTitle
      if (title !== undefined) titles.set(r.workspaceId, title)
    }
  }

  const workspaces = ids.map((workspaceId): WorkspaceUsageRow => {
    const live = usage.workspaces[workspaceId]
    const series = history.workspaces.get(workspaceId) ?? []
    const row = rowById.get(workspaceId)
    const project = row ? projectById.get(row.projectId) : undefined
    const title = titles.get(workspaceId)
    const owner = project ? userName.get(project.owner) : undefined
    return {
      workspaceId,
      running: live !== undefined,
      cpuCores: live?.cpuCores ?? 0,
      memoryBytes: live?.memoryBytes ?? 0,
      memoryLimitBytes: live?.memoryLimitBytes ?? null,
      ephemeralStorageBytes: live?.ephemeralStorageBytes ?? null,
      peakMemoryBytes: Math.max(live?.memoryBytes ?? 0, ...series.map((p) => p.memoryBytes)),
      history: series,
      ...(live?.node !== undefined ? { node: live.node } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(row ? { projectId: row.projectId } : {}),
      ...(project ? { projectName: project.name } : {}),
      ...(owner !== undefined ? { owner } : {}),
      ...(!live && row?.deathReason !== undefined ? { deathReason: row.deathReason } : {}),
      ...(!live && row?.deathDetail !== undefined ? { deathDetail: row.deathDetail } : {}),
    }
  }).sort((a, b) => b.memoryBytes - a.memoryBytes || b.peakMemoryBytes - a.peakMemoryBytes)

  const withHistory = <T>(item: T, series: UsagePoint[] | undefined) => ({ ...item, history: series ?? [] })
  return {
    driver: workspaceDriver().kind,
    sampledAt,
    totals: withHistory(usage.totals, history.totals),
    nodes: usage.nodes.map((n) => withHistory(n, history.nodes.get(n.name))),
    components: usage.components.map((c) => withHistory({
      ...c,
      ...(c.children
        ? { children: c.children.map((child) => ({ ...child, label: projectById.get(child.projectId)?.name ?? child.label })) }
        : {}),
    }, history.components.get(c.key))),
    workspaces,
  }
}
