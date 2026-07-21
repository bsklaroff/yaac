/**
 * Background-loop step that gives otherwise-untitled sessions a
 * model-generated title summarizing their first user message, written into
 * the same per-project store as user renames (`session-titles.json`) — a
 * rename simply overwrites the entry, and only sessions with no title at
 * all are eligible, so a user's title is never clobbered.
 *
 * Each tick fires one detached task per eligible session — the tick body
 * never blocks on a model download or inference (those serialize inside
 * the summarizer). One attempt per session per server run: the in-memory
 * `attempted` set covers in-flight dedup, failure memory, and
 * don't-regenerate after a user deliberately clears a generated title.
 */
import { listActiveSessions } from '#features/sessions/list'
import { setSessionTitle } from '#features/titles/titles'
import { shouldGenerateTitle, summarizeTitle } from '#features/titles/title-summarizer'
import { notifySessionListChanged } from '#features/sessions/notify'
import { serverLog } from '#log'
import { env } from '@yaac/shared/env'

/** Sessions already handled this server run; added synchronously before the
 *  task's first await so a concurrent tick can't double-fire. */
const attempted = new Set<string>()

/** Sweep active sessions once, firing detached title-generation tasks. */
export async function reconcileGeneratedTitles(): Promise<void> {
  if (!env.autoTitles) return

  let sessions
  try {
    sessions = (await listActiveSessions()).sessions
  } catch {
    return
  }

  for (const session of sessions) {
    const { projectSlug, sessionId, title, prompt } = session
    const key = `${projectSlug}:${sessionId}`
    if (attempted.has(key)) continue
    if (title !== undefined || prompt === undefined || !shouldGenerateTitle(prompt)) continue
    attempted.add(key)
    void generateOne(projectSlug, sessionId, prompt)
  }
}

async function generateOne(slug: string, sessionId: string, prompt: string): Promise<void> {
  try {
    const title = await summarizeTitle(prompt)
    if (title === undefined) return
    await setSessionTitle(slug, sessionId, title)
    notifySessionListChanged()
  } catch (err) {
    serverLog(`[titles] ${slug}/${sessionId}: ${String(err)}`)
  }
}

/** Test helper: forget which sessions were already attempted. */
export function _resetTitleGenerationForTests(): void {
  attempted.clear()
}
