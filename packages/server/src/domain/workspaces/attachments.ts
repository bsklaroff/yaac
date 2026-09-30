import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { sniffImage } from '@yaac/shared/attachments'
import { ServerError } from '@yaac/shared/errors'
import { workspaceAttachmentsDir } from '@yaac/shared/project-paths'
import { workspaceDriver } from '#drivers/driver'
import { resolveWorkspaceContainer } from './resolve'

/**
 * Save an image pasted into a terminal pane where the workspace's agent can
 * read it, and return the path to paste instead (docs/agent-modes.md,
 * "Images"). TUIs accept an image as a file path, as when a file is dropped
 * on a terminal. The file is named by content hash, so repeats dedupe and the
 * name needs no quoting. The route enforces the size cap. The workspace must
 * be running.
 */
export async function saveWorkspaceAttachment(
  idOrName: string,
  bytes: Uint8Array,
): Promise<{ path: string }> {
  const wt = await resolveWorkspaceContainer(idOrName, { requireRunning: true })
  const kind = sniffImage(bytes)
  if (!kind) throw new ServerError('VALIDATION', 'not a PNG, JPEG, GIF or WebP image')
  const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${kind.ext}`
  const dir = workspaceAttachmentsDir(wt.projectSlug, wt.workspaceId)
  // Created at launch with its mount; if it is missing, the workspace has no
  // mount and the agent could not open the path (docs/legacy-compat-shims.md).
  if (!existsSync(dir)) {
    throw new ServerError('CONFLICT', 'restart this workspace to paste images into it')
  }
  // Write only if absent: an existing file already holds these bytes, and
  // rewriting could truncate it mid-read or follow a symlink the agent made.
  await fs.writeFile(path.join(dir, name), bytes, { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EEXIST') throw err
  })
  return { path: path.posix.join(workspaceDriver().workspacePaths(wt.jobName).attachmentsDir, name) }
}
