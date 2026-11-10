import crypto from 'node:crypto'
import { deleteProjectIcon, getProjectIcon, setProjectIcon as storeProjectIcon, type ProjectIcon } from '#db'
import { authorizeProject, type Actor } from '#domain/access'
import { sniffImage } from '@yaac/shared/attachments'
import { ServerError } from '@yaac/shared/errors'
import { assertProjectExists } from './detail'

/* The picture a project's owner uploads for its chip to show in place of
 * its initial. */

/** The webapp shrinks a picture to chip size before uploading it; this
 *  only bounds what an API caller can store. */
export const MAX_ICON_BYTES = 512 * 1024

export async function readProjectIcon(projectId: string): Promise<ProjectIcon> {
  const icon = await getProjectIcon(projectId)
  if (!icon) throw new ServerError('NOT_FOUND', `project ${projectId} has no icon`)
  return icon
}

/** Replace the project's picture with an uploaded PNG, JPEG, GIF or WebP. */
export async function setProjectIcon(principal: Actor, projectId: string, bytes: Uint8Array): Promise<void> {
  await assertProjectExists(projectId)
  await authorizeProject(principal, projectId)
  await storeProjectIcon(projectId, toIcon(bytes))
}

export async function removeProjectIcon(principal: Actor, projectId: string): Promise<void> {
  await assertProjectExists(projectId)
  await authorizeProject(principal, projectId)
  await deleteProjectIcon(projectId)
}

function toIcon(bytes: Uint8Array): ProjectIcon {
  if (bytes.length > MAX_ICON_BYTES) throw new ServerError('TOO_LARGE', 'the icon is over the 512 KB limit')
  const type = sniffImage(bytes)
  if (type === undefined) throw new ServerError('VALIDATION', 'the icon must be a PNG, JPEG, GIF or WebP image')
  const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  return { mimeType: type.mimeType, bytes: Buffer.from(bytes), hash }
}
