import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { sniffImage } from '@yaac/shared/attachments'
import { ServerError } from '@yaac/shared/errors'
import { workspaceAttachmentsDir } from '@yaac/shared/project-paths'
import { workspaceDriver } from '#drivers/driver'
import { resolveWorkspaceContainer } from './resolve'
import type { Actor } from '#domain/access'

/**
 * Save an image pasted into a terminal pane where the workspace's agent can
 * read it, and return the path to paste instead (docs/agent-modes.md,
 * "Images"). TUIs accept an image as a file path, as when a file is dropped
 * on a terminal. The file is named by content hash, so repeats dedupe and the
 * name needs no quoting. The route enforces the size cap. The workspace must
 * be running; its launch created the directory along with its mount.
 */
export async function saveWorkspaceAttachment(
  principal: Actor,
  idOrName: string,
  bytes: Uint8Array,
): Promise<{ path: string }> {
  const wt = await resolveWorkspaceContainer(idOrName, { requireRunning: true, owner: principal })
  const kind = sniffImage(bytes)
  if (!kind) throw new ServerError('VALIDATION', 'not a PNG, JPEG, GIF or WebP image')
  const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${kind.ext}`
  const dir = workspaceAttachmentsDir(wt.projectId, wt.workspaceId)
  // Write only if absent: an existing file already holds these bytes, and
  // rewriting could truncate it mid-read or follow a symlink the agent made.
  await fs.writeFile(path.join(dir, name), bytes, { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EEXIST') throw err
  })
  return { path: path.posix.join(workspaceDriver().workspacePaths(wt.jobName).attachmentsDir, name) }
}
