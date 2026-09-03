import { transcriptStamp } from '#runtime/agents'

/**
 * The model a conversation is answering as, re-read from the file that records
 * it when that file has moved.
 *
 * WHICH file, and how it is read, is the caller's: a `tui` conversation is read
 * from the transcript its tool writes, an `acp` one from the record acpd keeps.
 * Only the caching is shared, because only the caching is the same problem.
 *
 * The sibling of `prompt-capture`, and deliberately NOT the same shape. An
 * opening message is read once and is then true forever, so that one caches
 * the answer and never looks again. A model is not that kind of fact: `/model`
 * mid-conversation changes it, and a row that froze the first answer would go
 * on claiming a model the agent stopped using hours ago. So this re-reads —
 * but only when there is something new to read.
 *
 * What gates the re-read is the transcript's stamp — mtime AND size, because
 * mtime alone can repeat across a real append on a filesystem with
 * one-second timestamps, and a gate that reads that as "unchanged" serves a
 * stale model until the next append happens to move the clock. A settled
 * conversation therefore costs one `stat` per tick, and a busy one costs a
 * tail read per tick — the reader scans BACKWARD from EOF, so that cost is a
 * few chunks rather than a walk through the whole conversation.
 *
 * Caching the *answer* against that stamp, including `undefined`, is what
 * keeps an agent that has not spoken yet from re-scanning its whole transcript
 * every tick: "read at this stamp, found nothing" is a real answer and is
 * worth remembering until the file moves again.
 *
 * In-memory, and per server life: the row is the record, so a restart re-reads
 * each running conversation once and writes back what it already held. The
 * caller only writes when the value actually changed, so that costs nothing.
 */
const known = new Map<string, { mtimeMs: number; size: number; model?: string }>()

export async function captureModel(
  key: string,
  filePath: string | undefined,
  read: (path: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  if (filePath === undefined) return undefined
  const stamp = await transcriptStamp(filePath)
  // No transcript to read — a conversation whose file has not appeared yet, or
  // whose pod wrote it somewhere this install cannot resolve. Nothing is
  // cached: the next tick tries again.
  if (stamp === undefined) return undefined

  const cached = known.get(key)
  if (cached?.mtimeMs === stamp.mtimeMs && cached.size === stamp.size) return cached.model

  const model = await read(filePath).catch(() => undefined)
  known.set(key, { ...stamp, ...(model !== undefined ? { model } : {}) })
  return model
}

/** Test helper: forget the models read so far. */
export function _resetModelCaptureForTests(): void {
  known.clear()
}
