import { useMemo } from 'react'
import { MAX_ATTACHMENT_BYTES } from '@yaac/shared/attachments'
import type { AcpImage } from '@yaac/shared/acp'
import { api } from '#lib/api'

/**
 * Images a user hands an agent (docs/agent-modes.md, "Images"): what a paste
 * or a drop carries, shrunk to what a model reads, and delivered the way the
 * pane's mode takes it — uploaded for a path under `tui`, inline under `acp`.
 */

/** The long edge the model APIs resize an image down to anyway; sending more
 *  is bytes nobody reads, and under `acp` bytes the record keeps for good. */
const MAX_EDGE = 1568

/** Past this, a PNG is re-encoded lossily if that is smaller: a chat image
 *  is replayed from the record on every attach, so its size is paid again
 *  and again. */
const COMPACT_BYTES = 1024 * 1024

const SENT_AS_IS = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** Plain text that is only a URL — what Firefox's Copy Image puts beside the
 *  image itself, and not text anyone meant to paste. */
const LONE_URL = /^(?:https?|file|data):\S+$/

/**
 * The images a paste or drop carries — none when it also carries plain text.
 * Word, Excel and friends put a picture of the copied selection on the
 * clipboard beside its text, and the text is what was meant. Text that is only
 * a URL does not count (see `LONE_URL`).
 */
export function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return []
  const text = data.getData('text/plain').trim()
  if (text !== '' && !LONE_URL.test(text)) return []
  return [...data.files].filter((f) => f.type.startsWith('image/'))
}

/**
 * The images on the system clipboard, read directly. For the Shift paste
 * chords, which browsers run as paste-as-plain-text: that paste's event
 * carries no image at all, so reading the clipboard is the only way to one.
 * None when the clipboard holds any text, which the chord's own paste is
 * already delivering, or when the page may not read it (a first read asks
 * for permission; an insecure origin has no clipboard API). Stricter than
 * `imageFiles` on purpose: a lone URL is text this paste cannot take back, so
 * attaching the image too would hand the agent both.
 */
export async function clipboardImages(): Promise<File[]> {
  try {
    const items = await navigator.clipboard.read()
    if (items.some((item) => item.types.includes('text/plain'))) return []
    const files: File[] = []
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (type !== undefined) files.push(new File([await item.getType(type)], 'clipboard', { type }))
    }
    return files
  } catch {
    return []
  }
}

/**
 * An image no larger than the model will read: sent as it is when it already
 * fits and is small, else redrawn at `MAX_EDGE` as a PNG — or as WebP, then
 * JPEG, when the PNG is over `COMPACT_BYTES` and that is smaller.
 */
export async function prepareImage(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const { width, height } = bitmap
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height))
  if (scale === 1 && file.size <= COMPACT_BYTES && SENT_AS_IS.has(file.type)) {
    bitmap.close()
    return file
  }
  const canvas = new OffscreenCanvas(Math.round(width * scale), Math.round(height * scale))
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  let blob = await canvas.convertToBlob({ type: 'image/png' })
  // A browser that cannot encode one of these hands back a PNG instead, which
  // is never smaller, so it is simply not taken.
  for (const type of ['image/webp', 'image/jpeg']) {
    if (blob.size <= COMPACT_BYTES) break
    const lossy = await canvas.convertToBlob({ type, quality: 0.9 })
    if (lossy.size < blob.size) blob = lossy
  }
  if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error('the image is over the 5 MB limit')
  return blob
}

/** Upload an image to a running workspace; answers the path its agent reads it
 *  at, to paste in the image's place. */
export async function uploadAttachment(workspaceId: string, image: Blob): Promise<string> {
  const { path } = await api.workspace[':id'].attachments.$post(
    { param: { id: workspaceId } },
    { init: { body: image, headers: { 'Content-Type': image.type } } },
  )
  return path
}

/** An image as the ACP image block a chat message carries it in. */
export async function toAcpImage(image: Blob): Promise<AcpImage> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('could not read the image'))
    reader.readAsDataURL(image)
  })
  return { type: 'image', mimeType: image.type, data: url.slice(url.indexOf(',') + 1) }
}

/** An image block as something an `<img>` can show — built once per image,
 *  since it is megabytes of string and a transcript re-renders per event. */
export function useImageSrc(image: AcpImage): string {
  return useMemo(() => `data:${image.mimeType};base64,${image.data}`, [image])
}

/** How many bytes an image block decodes to. */
export function imageBytes(image: AcpImage): number {
  return Math.floor(image.data.length * 3 / 4) - (image.data.match(/=*$/)?.[0].length ?? 0)
}
