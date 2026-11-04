import { MAX_ATTACHMENT_BYTES, sniffImage } from '@yaac/shared/attachments'
import type { AcpImage } from '@yaac/shared/acp'

/**
 * Validate the images a client sends inline as base64 (a chat message's, a
 * feedback report's) like the terminal upload route does: by sniffing the
 * bytes, not the declared type, with the size cap applied to all of them
 * together. Returns the first refusal as a string, so the caller drops the
 * whole request rather than sending it without an image. The re-encoded
 * bytes are returned, since base64 decoding skips invalid characters.
 */
export function inlineImages(raw: unknown): AcpImage[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return 'malformed images'
  const images: AcpImage[] = []
  let total = 0
  for (const entry of raw as Array<Partial<AcpImage> | null>) {
    if (typeof entry?.data !== 'string') return 'malformed image'
    const bytes = Buffer.from(entry.data, 'base64')
    total += bytes.byteLength
    if (total > MAX_ATTACHMENT_BYTES) return 'its images are over the 5 MB limit'
    const kind = sniffImage(bytes)
    if (!kind) return 'an image is not a PNG, JPEG, GIF or WebP'
    images.push({ type: 'image', mimeType: kind.mimeType, data: bytes.toString('base64') })
  }
  return images
}
