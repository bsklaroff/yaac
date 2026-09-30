/**
 * Reconcile step that gives untitled live workspaces a model-generated title
 * summarizing their first user message. It is written to the same column as
 * a user rename, and only if the row is still untitled, so a rename made
 * while the model runs wins.
 *
 * Drafts and queued entries without a user title are titled from their
 * prompt the same way; the write only lands if the prompt is unchanged.
 *
 * Each tick fires detached tasks, so it never blocks on a model download or
 * inference (the summarizer serializes those). The in-memory `attempted` set
 * allows one attempt per workspace (or per draft/entry prompt) per server
 * run, which also stops regeneration after a user clears a generated title.
 */
import {
  firstAgentSessionsFor,
  listDraftWorkspaceRows,
  listQueuedWorkspaceRows,
  listWorkspaceRows,
  setDraftWorkspaceTitle,
  setQueuedWorkspaceTitle,
  setWorkspaceTitle,
} from '#db'
import { shouldGenerateTitle, summarizeTitle } from './title-summarizer'
import { serverLog } from '#log'
import { env } from '@yaac/shared/env'

/** Keys already attempted this server run. */
const attempted = new Set<string>()

/** Sweep live workspaces, drafts and queued entries once, firing detached
 *  title-generation tasks. Reads only rows; the runtime isn't consulted. */
export async function reconcileGeneratedTitles(): Promise<void> {
  if (!env.autoTitles) return

  const untitled = (await listWorkspaceRows())
    .filter((r) => r.stoppedAt === undefined && r.title === undefined)
  const firsts = await firstAgentSessionsFor(untitled)
  for (const { projectSlug, workspaceId } of untitled) {
    const key = `${projectSlug}/${workspaceId}`
    const prompt = firsts.get(key)?.firstPrompt
    if (prompt === undefined) continue
    void generateOnce(key, key, prompt, (t) => setWorkspaceTitle(projectSlug, workspaceId, t, { ifUntitled: true }))
  }
  // Drafts and entries are keyed on the prompt too, so an edited prompt gets
  // its own attempt.
  for (const { id, prompt, title, generatedTitle } of await listDraftWorkspaceRows()) {
    if (title !== undefined || generatedTitle !== undefined) continue
    void generateOnce(`draft:${id}:${prompt}`, `draft ${id}`, prompt, (t) => setDraftWorkspaceTitle(id, prompt, t))
  }
  for (const { id, prompt, title, generatedTitle, launchWorkspaceId } of await listQueuedWorkspaceRows()) {
    if (title !== undefined || generatedTitle !== undefined || launchWorkspaceId !== undefined) continue
    void generateOnce(`queued:${id}:${prompt}`, `queued ${id}`, prompt, (t) => setQueuedWorkspaceTitle(id, prompt, t))
  }
}

/** One attempt per key, claimed before the first await so a concurrent tick
 *  can't double-fire. */
async function generateOnce(
  key: string,
  label: string,
  prompt: string,
  write: (title: string) => Promise<unknown>,
): Promise<void> {
  if (attempted.has(key) || !shouldGenerateTitle(prompt)) return
  attempted.add(key)
  try {
    const title = await summarizeTitle(prompt)
    if (title !== undefined) await write(title)
  } catch (err) {
    serverLog(`[titles] ${label}: ${String(err)}`)
  }
}

/** Test helper: forget which keys were already attempted. */
export function _resetTitleGenerationForTests(): void {
  attempted.clear()
}
