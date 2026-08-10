import fs from 'node:fs/promises'

const CHUNK_SIZE = 4096

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
