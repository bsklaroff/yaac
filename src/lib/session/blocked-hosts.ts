import fs from 'node:fs/promises'
import { blockedHostsDir, blockedHostsFile } from '@/lib/project/paths'
import type { ProxyClient } from '@/lib/container/proxy-client'

export async function fetchAndPersistBlockedHosts(
  proxyClient: ProxyClient,
  sessions: Array<{ sessionId: string; projectSlug: string }>,
): Promise<Record<string, string[]>> {
  let allBlocked: Record<string, string[]>
  try {
    allBlocked = await proxyClient.getBlockedHosts()
  } catch {
    return {}
  }

  // Build a lookup from sessionId to projectSlug
  const slugBySession = new Map(sessions.map((s) => [s.sessionId, s.projectSlug]))

  // Write a file for each session that has blocked hosts
  const dirsCreated = new Set<string>()
  for (const [sessionId, hosts] of Object.entries(allBlocked)) {
    const slug = slugBySession.get(sessionId)
    if (!slug || hosts.length === 0) continue

    const dir = blockedHostsDir(slug)
    if (!dirsCreated.has(dir)) {
      await fs.mkdir(dir, { recursive: true })
      dirsCreated.add(dir)
    }

    const filePath = blockedHostsFile(slug, sessionId)
    await fs.writeFile(filePath, JSON.stringify(hosts, null, 2) + '\n')
  }

  return allBlocked
}

export async function readBlockedHosts(slug: string, sessionId: string): Promise<string[]> {
  const filePath = blockedHostsFile(slug, sessionId)
  try {
    const data = await fs.readFile(filePath, 'utf8')
    return JSON.parse(data) as string[]
  } catch {
    return []
  }
}

export async function readAllBlockedHosts(
  sessions: Array<{ sessionId: string; projectSlug: string }>,
): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {}
  await Promise.all(
    sessions.map(async ({ sessionId, projectSlug }) => {
      const hosts = await readBlockedHosts(projectSlug, sessionId)
      if (hosts.length > 0) {
        result[sessionId] = hosts
      }
    }),
  )
  return result
}
