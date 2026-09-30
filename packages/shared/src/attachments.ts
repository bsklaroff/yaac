/**
 * Images a user hands an agent: pasted into a terminal pane (uploaded, then
 * named by path) or attached to a chat message (sent inline as an ACP image
 * block). See docs/agent-modes.md, "Images".
 */

/**
 * Max image bytes per message after browser downscaling: one terminal
 * upload, or all images of a chat message together. Roughly the model
 * APIs' per-image limit; chat images are also kept in the conversation log
 * permanently.
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
 * Detect PNG, JPEG, GIF or WebP (the types every supported agent accepts)
 * from the magic bytes, ignoring the declared type. Undefined otherwise.
 */
export function sniffImage(bytes: Uint8Array): { mimeType: string; ext: string } | undefined {
  const match = SIGNATURES.find((s) => s.test(bytes))
  return match && { mimeType: match.mimeType, ext: match.ext }
}
