import fs from 'node:fs/promises'

const CHUNK_SIZE = 4096

/** A slice of a read buffer. `subarray` keeps whatever backs its source, so
 *  the looser `ArrayBufferLike` is what these actually pass around. */
type Bytes = Buffer<ArrayBufferLike>

const EMPTY: Bytes = Buffer.alloc(0)

/** Split a buffer on newlines, keeping every field (including empty ones) so
 *  the caller can tell a trailing partial line from a complete one. */
function splitLines(buf: Bytes): Bytes[] {
  const lines: Bytes[] = []
  let from = 0
  for (;;) {
    const nl = buf.indexOf(0x0a, from)
    if (nl < 0) break
    lines.push(buf.subarray(from, nl))
    from = nl + 1
  }
  lines.push(buf.subarray(from))
  return lines
}

/**
 * Fill `buf` from `position`, looping over short reads; false when the file
 * ended before it could be filled.
 *
 * `read` is permitted to return fewer bytes than asked for, and on a regular
 * local file below EOF it effectively never does — but the whole point of
 * working in byte ranges here is that a silently wrong byte is worse than a
 * missing answer, and an unfilled tail is exactly that.
 */
async function readFully(handle: fs.FileHandle, buf: Bytes, position: number): Promise<boolean> {
  let filled = 0
  while (filled < buf.length) {
    const { bytesRead } = await handle.read(buf, filled, buf.length - filled, position + filled)
    if (bytesRead === 0) return false
    filled += bytesRead
  }
  return true
}

/** One line's mapped value, or undefined when it is blank, unparseable, or
 *  simply not what the caller is looking for. */
function parseLine<T>(line: Bytes, mapEntry: (entry: unknown) => T | undefined): T | undefined {
  const text = line.toString('utf8').trim()
  if (text.length === 0) return undefined
  let entry: unknown
  try {
    entry = JSON.parse(text)
  } catch {
    return undefined
  }
  return mapEntry(entry)
}


/**
 * Scans a JSONL file from the start and returns the first mapped value that
 * is not undefined. Reads incrementally so large metadata preambles do not
 * hide later entries.
 */
export async function scanJsonlForward<T>(
  jsonlPath: string,
  mapEntry: (entry: unknown) => T | undefined,
): Promise<T | undefined> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(jsonlPath, 'r')
    const stat = await handle.stat()
    if (stat.size === 0) return undefined

    let offset = 0
    let carryover = ''

    while (offset < stat.size) {
      const chunkSize = Math.min(CHUNK_SIZE, stat.size - offset)
      const buf = Buffer.alloc(chunkSize)
      await handle.read(buf, 0, chunkSize, offset)
      offset += chunkSize

      const raw = carryover + buf.toString('utf8')
      const parts = raw.split('\n')
      carryover = parts.pop() ?? ''

      for (const part of parts) {
        const line = part.trim()
        if (line.length === 0) continue

        let entry: unknown
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }

        const mapped = mapEntry(entry)
        if (mapped !== undefined) return mapped
      }
    }

    if (carryover.trim().length > 0) {
      try {
        const entry = JSON.parse(carryover) as unknown
        return mapEntry(entry)
      } catch {
        return undefined
      }
    }

    return undefined
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

/**
 * The same scan from the other end: reads chunks backwards from EOF and
 * returns the first mapped value, so "the newest entry that says X" costs a
 * tail read rather than a walk through a conversation that may be hundreds of
 * megabytes of tool output.
 *
 * The carryover runs the other way too — a chunk boundary splits a line at its
 * *front*, so the partial head is held over and prepended to the next
 * (earlier) chunk. Lines within a chunk are then walked last-to-first, which
 * is what makes the first match the latest one.
 */
export async function scanJsonlBackward<T>(
  jsonlPath: string,
  mapEntry: (entry: unknown) => T | undefined,
): Promise<T | undefined> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(jsonlPath, 'r')
    const stat = await handle.stat()
    if (stat.size === 0) return undefined

    let end = stat.size
    // Held as BYTES, and every line is decoded from its own complete byte
    // range: a chunk boundary can fall inside a multi-byte character, so
    // decoding a chunk on its own would turn a split glyph into replacement
    // characters. Splitting on 0x0A first is safe at any boundary — a newline
    // byte can never be a UTF-8 continuation byte.
    let carryover: Bytes = EMPTY

    while (end > 0) {
      const chunkSize = Math.min(CHUNK_SIZE, end)
      const start = end - chunkSize
      const buf = Buffer.alloc(chunkSize)
      // A short read would leave `Buffer.alloc`'s zero padding spliced into
      // the middle of the stream, where it corrupts a line silently — it
      // still parses as "not JSON", so the scan just answers with an older
      // value or none. Refusing to answer beats that: the caller treats
      // undefined as "not read" and keeps whatever it already had.
      if (!await readFully(handle, buf, start)) return undefined
      end = start

      const raw = Buffer.concat([buf, carryover])
      const parts = splitLines(raw)
      // The first element is a line whose beginning lies in the previous
      // (earlier) chunk — unless this chunk starts the file, in which case it
      // is whole and must be scanned rather than carried into nothing.
      carryover = start > 0 ? parts.shift() ?? EMPTY : EMPTY

      for (let i = parts.length - 1; i >= 0; i--) {
        const mapped = parseLine(parts[i], mapEntry)
        if (mapped !== undefined) return mapped
      }
    }

    return undefined
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}
