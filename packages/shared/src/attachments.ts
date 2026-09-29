/**
 * Images a user hands an agent: pasted into a terminal pane (uploaded, then
 * named by path) or attached to a chat message (sent inline as an ACP image
 * block). See docs/agent-modes.md, "Images".
 */

/**
 * The most image bytes one message may carry, after the browser has
 * downscaled them: a terminal upload whole, or every image of a chat message
 * together. The model APIs cap an image at about this and a request at a few
 * times it, and a chat image is recorded in the conversation's record for
 * good, so anything bigger is refused rather than stored.
 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

const SIGNATURES: ReadonlyArray<{ mimeType: string; ext: string; test: (b: Uint8Array) => boolean }> = [
  {
    mimeType: 'image/png',
    ext: 'png',
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  { mimeType: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mimeType: 'image/gif', ext: 'gif', test: (b) => ascii(b, 0, 'GIF8') },
  { mimeType: 'image/webp', ext: 'webp', test: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP') },
]

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false
  }
  return true
}

/**
 * What image `bytes` actually are — PNG, JPEG, GIF or WebP, the types every
 * agent yaac runs accepts — read from the magic bytes rather than from
 * whatever type the sender declared. Undefined for anything else.
 */
export function sniffImage(bytes: Uint8Array): { mimeType: string; ext: string } | undefined {
  const match = SIGNATURES.find((s) => s.test(bytes))
  return match && { mimeType: match.mimeType, ext: match.ext }
}
