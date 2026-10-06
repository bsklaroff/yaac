import type { FileHandle } from 'node:fs/promises'
import { openSandboxFile, type SandboxFile } from './sandbox-fs'

const CHUNK_SIZE = 64 * 1024

/** A JSON value, or undefined for text that is not JSON (a line cut short
 *  mid-write, stray output). */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** A JSONL text's object lines, in order; blank and unparseable lines are
 *  skipped. */
export function jsonObjects(raw: string): Array<Record<string, unknown>> {
  return raw.split('\n')
    .map((line): unknown => (line.trim() === '' ? undefined : parseJson(line)))
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v))
}

/** How far into a transcript a scan reads. The target (an opening message)
 *  is near the top; this bounds the cost of an agent-grown file. */
const MAX_SCAN_BYTES = 64 * 1024 * 1024

/**
 * Scan a JSONL file from the start and return the first mapped value that
 * is not undefined. Reads incrementally and finds line ends as bytes
 * arrive, so each byte is examined once and an endless line costs linear
 * time.
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
    // Chunks of the line currently being read.
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
