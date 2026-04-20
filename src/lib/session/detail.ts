import { podman } from '@/lib/container/runtime'
import { getDataDir } from '@/lib/project/paths'
import { DaemonError } from '@/daemon/errors'
import { getSessionFirstMessage, getToolFromContainer } from '@/lib/session/status'
import { readBlockedHosts } from '@/lib/session/blocked-hosts'
import type { AgentTool } from '@/shared/types'

export interface SessionDetail {
  sessionId: string
  projectSlug: string
  containerName: string
  state: string
  tool: AgentTool
  labels: Record<string, string>
  blockedHostsCount: number
  /** ISO timestamp of container creation. */
  createdAt: string
}

interface MatchedContainer {
  name: string
  sessionId: string
  projectSlug: string
  state: string
  tool: AgentTool
  labels: Record<string, string>
  createdAt: string
}

async function findSessionContainer(idOrName: string): Promise<MatchedContainer> {
  let containers
  try {
    containers = await podman.listContainers({
      all: true,
      filters: { label: [`yaac.data-dir=${getDataDir()}`] },
    })
  } catch (err) {
    throw new DaemonError('PODMAN_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }
  const match = containers.find((c) => {
    const sessionId = c.Labels?.['yaac.session-id'] ?? ''
    const name = c.Names?.[0]?.replace(/^\//, '') ?? ''
    return sessionId === idOrName
      || name === idOrName
      || sessionId.startsWith(idOrName)
      || c.Id.startsWith(idOrName)
  })
  if (!match) throw new DaemonError('NOT_FOUND', `session ${idOrName} not found`)
  return {
    name: match.Names?.[0]?.replace(/^\//, '') ?? match.Id,
    sessionId: match.Labels?.['yaac.session-id'] ?? '',
    projectSlug: match.Labels?.['yaac.project'] ?? '',
    state: match.State ?? 'unknown',
    tool: getToolFromContainer(match),
    labels: match.Labels ?? {},
    createdAt: new Date(match.Created * 1000).toISOString(),
  }
}

export async function getSessionDetail(idOrName: string): Promise<SessionDetail> {
  const match = await findSessionContainer(idOrName)
  const blocked = match.sessionId && match.projectSlug
    ? await readBlockedHosts(match.projectSlug, match.sessionId)
    : []
  return {
    sessionId: match.sessionId,
    projectSlug: match.projectSlug,
    containerName: match.name,
    state: match.state,
    tool: match.tool,
    labels: match.labels,
    blockedHostsCount: blocked.length,
    createdAt: match.createdAt,
  }
}

export async function getSessionBlockedHosts(idOrName: string): Promise<string[]> {
  const match = await findSessionContainer(idOrName)
  if (!match.sessionId || !match.projectSlug) return []
  return readBlockedHosts(match.projectSlug, match.sessionId)
}

export async function getSessionPrompt(idOrName: string): Promise<string | undefined> {
  const match = await findSessionContainer(idOrName)
  if (!match.sessionId || !match.projectSlug) return undefined
  return getSessionFirstMessage(match.projectSlug, match.sessionId, match.tool)
}
