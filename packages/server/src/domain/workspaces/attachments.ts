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
 * Keep an image pasted into a terminal pane where the workspace's agent can
 * read it, and answer the path to paste in its place (docs/agent-modes.md,
 * "Images").
 *
 * A path because that is what every TUI yaac runs already takes an image as —
 * it is what a terminal sends when a file is dropped on it. Named by content
 * hash, so the same screenshot pasted twice is one file, and the name needs
 * no quoting in the pane.
 *
 * The size cap is the route's, enforced before the body is buffered.
 *
 * Only for a RUNNING workspace: an agent copies the image in when the path is
 * pasted, so there is nothing to do for one that is not there to read it.
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
  // Made at launch, alongside the mount that shows it to the workspace — so a
  // workspace without it was launched without the mount, and a path answered
  // for it would name nothing its agent can open (docs/legacy-compat-shims.md).
  if (!existsSync(dir)) {
    throw new ServerError('CONFLICT', 'restart this workspace to paste images into it')
  }
  // Written only if absent: a file of this name already holds these bytes, and
  // rewriting it would truncate it under an agent reading the earlier paste —
  // or, under containerless, follow a link the agent put in its place.
  await fs.writeFile(path.join(dir, name), bytes, { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EEXIST') throw err
  })
  return { path: path.posix.join(workspaceDriver().workspacePaths(wt.jobName).attachmentsDir, name) }
}
