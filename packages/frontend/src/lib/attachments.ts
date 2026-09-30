import { useMemo } from 'react'
import { MAX_ATTACHMENT_BYTES } from '@yaac/shared/attachments'
import type { AcpImage } from '@yaac/shared/acp'
import { api } from '#lib/api'

/**
 * Images a user pastes or drops for an agent (docs/agent-modes.md,
 * "Images"): shrunk to what a model reads, then uploaded for a file path
 * under `tui` or sent inline under `acp`.
 */

/** The long edge model APIs resize images down to anyway. Larger images
 *  waste bytes, which under `acp` stay in the record for good. */
const MAX_EDGE = 1568

/** Above this size a PNG is re-encoded lossily if that is smaller, since a
 *  chat image is re-sent on every attach. */
const COMPACT_BYTES = 1024 * 1024

const SENT_AS_IS = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** Text that is only a URL, which Firefox's Copy Image puts beside the
 *  image. */
const LONE_URL = /^(?:https?|file|data):\S+$/

/**
 * The images a paste or drop carries, or none if it also carries text:
 * Office apps put a picture of the selection beside its text, and the text
 * is what was meant. Text that is only a URL doesn't count (`LONE_URL`).
 */
export function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return []
  const text = data.getData('text/plain').trim()
  if (text !== '' && !LONE_URL.test(text)) return []
  return [...data.files].filter((f) => f.type.startsWith('image/'))
}

/**
 * The images on the system clipboard, read directly. Used for the Shift
 * paste shortcuts, which browsers run as plain-text pastes whose event
 * carries no image. Returns none when the clipboard holds any text (that
 * paste already delivers it, even a lone URL) or when the page can't read
 * the clipboard (permission denied, or an insecure origin).
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
 * Shrink an image to what the model reads. Small images that fit are sent
 * as-is; others are redrawn to fit `MAX_EDGE` as PNG, or as WebP / JPEG when
 * the PNG exceeds `COMPACT_BYTES` and the lossy version is smaller.
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
  // A browser that can't encode a type returns PNG, which is never smaller.
  for (const type of ['image/webp', 'image/jpeg']) {
    if (blob.size <= COMPACT_BYTES) break
    const lossy = await canvas.convertToBlob({ type, quality: 0.9 })
    if (lossy.size < blob.size) blob = lossy
  }
  if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error('the image is over the 5 MB limit')
  return blob
}

/** Upload an image to a running workspace and return the path its agent
 *  reads it from, to paste in the image's place. */
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

/** An image block as a data URL for `<img>`. Memoized because it can be
 *  megabytes and the transcript re-renders on every event. */
export function useImageSrc(image: AcpImage): string {
  return useMemo(() => `data:${image.mimeType};base64,${image.data}`, [image])
}

/** How many bytes an image block decodes to. */
export function imageBytes(image: AcpImage): number {
  return Math.floor(image.data.length * 3 / 4) - (image.data.match(/=*$/)?.[0].length ?? 0)
}
