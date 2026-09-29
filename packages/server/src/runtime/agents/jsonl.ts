import type { FileHandle } from 'node:fs/promises'
import { openSandboxFile, type SandboxFile } from './sandbox-fs'

const CHUNK_SIZE = 64 * 1024

/** How far into a transcript a scan looks. What it looks for (an opening
 *  message) sits near the top; this only bounds what a file the agent grew
 *  without limit can cost. */
const MAX_SCAN_BYTES = 64 * 1024 * 1024

/**
 * Scans a JSONL file from the start and returns the first mapped value that
 * is not undefined. Reads incrementally so large metadata preambles do not
 * hide later entries, and finds line ends in the bytes as they arrive, so
 * every byte is looked at once however long a line runs — a line with no
 * end costs its length, not its square.
 */
export async function scanJsonlForward<T>(
  file: SandboxFile,
  mapEntry: (entry: unknown) => T | undefined,
): Promise<T | undefined> {
  const parse = (bytes: Buffer): T | undefined => {
    const line = bytes.toString('utf8').trim()
    if (line.length === 0) return undefined
    try {
      return mapEntry(JSON.parse(line) as unknown)
    } catch {
      return undefined
    }
  }
  let handle: FileHandle | null = null
  try {
    handle = await openSandboxFile(file)
    if (handle === null) return undefined
    const size = Math.min((await handle.stat()).size, MAX_SCAN_BYTES)
    // The line the scan is in the middle of, as the chunks that hold it.
    let partial: Buffer[] = []
    let offset = 0
    while (offset < size) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, size - offset))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset)
      if (bytesRead === 0) break
      offset += bytesRead
      const bytes = chunk.subarray(0, bytesRead)
      let start = 0
      for (let nl = bytes.indexOf(0x0a); nl !== -1; nl = bytes.indexOf(0x0a, start)) {
        const mapped = parse(Buffer.concat([...partial, bytes.subarray(start, nl)]))
        partial = []
        if (mapped !== undefined) return mapped
        start = nl + 1
      }
      if (start < bytes.length) partial.push(bytes.subarray(start))
    }
    return partial.length > 0 ? parse(Buffer.concat(partial)) : undefined
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}
