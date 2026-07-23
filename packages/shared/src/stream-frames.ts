/**
 * Frame codec for streamd `pty` streams: `[1B type][4B BE length][payload]`.
 *
 * client → pod: 0 data, 1 resize {cols,rows}, 2 signal {name}
 * pod → client: 0 data, 3 exit {code}
 *
 * Mirror of dockerfiles/streamd/framing.js (the in-pod side, plain JS
 * with no build step, so it cannot import this module) — keep in sync.
 */

export const FRAME_DATA = 0
export const FRAME_RESIZE = 1
export const FRAME_SIGNAL = 2
export const FRAME_EXIT = 3

const HEADER_BYTES = 5
/** Cap on a single frame's payload; a violation is a protocol error. */
export const MAX_FRAME_BYTES = 1024 * 1024

export interface StreamFrame {
  type: number
  payload: Buffer
}

/** Encode one frame. `payload` is a Buffer (data) or a JSON-able value. */
export function encodeFrame(type: number, payload: Buffer | object): Buffer {
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(JSON.stringify(payload), 'utf8')
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt8(type, 0)
  header.writeUInt32BE(body.length, 1)
  return Buffer.concat([header, body])
}

/**
 * Incremental frame parser. feed() buffers arbitrary chunk boundaries and
 * returns every complete frame; throws on an oversized frame (protocol
 * error — the caller should destroy the stream).
 */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0)

  feed(chunk: Buffer): StreamFrame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const frames: StreamFrame[] = []
    for (;;) {
      if (this.buf.length < HEADER_BYTES) return frames
      const type = this.buf.readUInt8(0)
      const length = this.buf.readUInt32BE(1)
      if (length > MAX_FRAME_BYTES) throw new Error(`frame too large (${length} bytes)`)
      if (this.buf.length < HEADER_BYTES + length) return frames
      frames.push({ type, payload: this.buf.subarray(HEADER_BYTES, HEADER_BYTES + length) })
      this.buf = this.buf.subarray(HEADER_BYTES + length)
    }
  }
}
