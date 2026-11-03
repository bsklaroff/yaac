/**
 * A workspace's terminal logs (docs/workspace-steps.md "Logs"): what each
 * window but an agent's printed, one dir per life, kept until the workspace
 * is deleted. Read from the host, so a stopped workspace's logs read the
 * same as a running one's, and only as a confined root, since the workspace
 * writes the dir (`openTerminalLogs`).
 */
import { constants as C } from 'node:fs'
import { ServerError } from '@yaac/shared/errors'
import type { WorkspaceLogLife } from '@yaac/shared/types'
import type { Actor } from '#domain/access'
import { resolveWorkspaceRecord } from './resolve'
import { authorizeWorkspace } from './steps'
import { openTerminalLogs } from './life'

/** A life dir (`lifeDirName`) and a file in one: no separators, no `..`. */
const LIFE = /^\d{4}-\d{2}-\d{2}T[\d.-]+Z$/
const FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:log(?:\.1)?|events)$/

/** At most this much of a log is answered at once. */
const READ_LIMIT = 4 * 1024 * 1024

/** Each life's log files, newest life first. */
export async function listWorkspaceLogs(principal: Actor, idOrPrefix: string): Promise<WorkspaceLogLife[]> {
  const { projectId, workspaceId } = await resolveWorkspaceRecord(idOrPrefix)
  await authorizeWorkspace(principal, workspaceId)
  const logs = await openTerminalLogs(projectId, workspaceId)
  const lives = (await logs.readdir('')).filter((d) => d.isDirectory() && LIFE.test(d.name)).map((d) => d.name).sort().reverse()
  return await Promise.all(lives.map(async (life) => {
    const names = (await logs.readdir(life)).filter((f) => f.isFile() && FILE.test(f.name)).map((f) => f.name).sort()
    const files = await Promise.all(names.map(async (name) => ({ name, size: (await logs.stat(`${life}/${name}`))?.size ?? 0 })))
    return { life, files }
  }))
}

/**
 * Up to 4 MiB of one log file from byte `offset`, and the offset after it,
 * so a client follows a log that is still being written by asking again
 * from there.
 */
export async function readWorkspaceLog(
  principal: Actor,
  idOrPrefix: string,
  life: string,
  file: string,
  offset = 0,
): Promise<{ data: Buffer; next: number; size: number }> {
  if (!LIFE.test(life) || !FILE.test(file)) throw new ServerError('VALIDATION', 'not a log file')
  const { projectId, workspaceId } = await resolveWorkspaceRecord(idOrPrefix)
  await authorizeWorkspace(principal, workspaceId)
  const logs = await openTerminalLogs(projectId, workspaceId)
  const handle = await logs.open(`${life}/${file}`, C.O_RDONLY).catch(() => {
    throw new ServerError('NOT_FOUND', `no log ${life}/${file}`)
  })
  try {
    const { size } = await handle.stat()
    const start = Math.min(Math.max(0, offset), size)
    const data = Buffer.alloc(Math.min(READ_LIMIT, size - start))
    const { bytesRead } = await handle.read(data, 0, data.length, start)
    return { data: data.subarray(0, bytesRead), next: start + bytesRead, size }
  } finally {
    await handle.close()
  }
}
