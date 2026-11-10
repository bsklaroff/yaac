/**
 * A workspace's terminal logs (docs/workspace-steps.md "Logs"): what each
 * window but an agent's printed, one dir per life, kept until the workspace
 * is deleted. Read from the host, so a stopped workspace's logs read the
 * same as a running one's, and only as a confined root, since the workspace
 * writes the dir (`openTerminalLogs`).
 */
import { constants as C } from 'node:fs'
import { ServerError } from '@yaac/shared/errors'
import { isAgentWindow, lifeDirName } from '@yaac/shared/steps'
import type { WorkspaceLogLife } from '@yaac/shared/types'
import type { Actor } from '#domain/access'
import { resolveWorkspaceRecord } from './resolve'
import { authorizeWorkspace } from './steps'
import { openTerminalLogs } from './life'

/** A life dir (`lifeDirName`) and a file in one, its window's name
 *  captured: no separators, no `..`. */
const LIFE = /^\d{4}-\d{2}-\d{2}T[\d.-]+Z$/
const FILE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\.(?:log(?:\.1)?|events)$/

/** At most this much of a log is answered at once. */
export const READ_LIMIT = 4 * 1024 * 1024

/** How much of a log `readWindowLogEnd` reads at a time. */
const CHUNK = 256 * 1024

/** A window of a life, as a step row names one. */
interface LoggedWindow {
  life: Date
  name: string
}

/** A window's log files, the rotated-out part first. */
function windowLogFiles({ life, name }: LoggedWindow): string[] {
  return [`${lifeDirName(life)}/${name}.log.1`, `${lifeDirName(life)}/${name}.log`]
}

/** Each life's log files, newest life first. An agent session's are left
 *  out (`isAgentWindow`), though `readWorkspaceLog` still serves them. */
export async function listWorkspaceLogs(principal: Actor, idOrPrefix: string): Promise<WorkspaceLogLife[]> {
  const { projectId, workspaceId } = await resolveWorkspaceRecord(idOrPrefix)
  await authorizeWorkspace(principal, workspaceId)
  const logs = await openTerminalLogs(projectId, workspaceId)
  const lives = (await logs.readdir('')).filter((d) => d.isDirectory() && LIFE.test(d.name)).map((d) => d.name).sort().reverse()
  return await Promise.all(lives.map(async (life) => {
    const names = (await logs.readdir(life)).flatMap((f) => {
      const window = f.isFile() ? FILE.exec(f.name)?.[1] : undefined
      return window !== undefined && !isAgentWindow(window) ? [f.name] : []
    }).sort()
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

/** How many bytes each window's log holds. */
export async function windowLogSizes(projectId: string, workspaceId: string, windows: LoggedWindow[]): Promise<number[]> {
  const logs = await openTerminalLogs(projectId, workspaceId)
  return await Promise.all(windows.map(async (w) => {
    const sizes = await Promise.all(windowLogFiles(w).map(async (f) => (await logs.stat(f))?.size ?? 0))
    return sizes[0] + sizes[1]
  }))
}

/**
 * The end of a window's log: enough of it for its last `lines` lines, or
 * all of it, but never more than 4 MiB, read backwards so a long log costs
 * only what is answered. `skipped` is how many bytes come before `data`.
 * Undefined when the window has logged nothing. The current half is read
 * before the rotated-out one, so a rotation between the two reads can
 * repeat a stretch but never drop one.
 */
export async function readWindowLogEnd(
  projectId: string,
  workspaceId: string,
  window: LoggedWindow,
  lines?: number,
): Promise<{ data: Buffer; skipped: number } | undefined> {
  const logs = await openTerminalLogs(projectId, workspaceId)
  const chunks: Buffer[] = []
  let taken = 0
  let newlines = 0
  let skipped = 0
  let found = false
  const enough = (): boolean => taken >= READ_LIMIT || (lines !== undefined && newlines > lines)
  for (const file of windowLogFiles(window).reverse()) {
    const handle = await logs.open(file, C.O_RDONLY).catch(() => undefined)
    if (handle === undefined) continue
    found = true
    try {
      let end = (await handle.stat()).size
      while (end > 0 && !enough()) {
        const start = Math.max(0, end - Math.min(CHUNK, READ_LIMIT - taken))
        const chunk = Buffer.alloc(end - start)
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, start)
        chunks.unshift(chunk.subarray(0, bytesRead))
        taken += bytesRead
        for (const byte of chunk.subarray(0, bytesRead)) if (byte === 0x0a) newlines++
        end = start
      }
      skipped += end
    } finally {
      await handle.close()
    }
  }
  return found ? { data: Buffer.concat(chunks), skipped } : undefined
}
