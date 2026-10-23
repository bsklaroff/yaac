/**
 * Reconcile step that generates titles where no agent gives one
 * (docs/workspace-titles.md): a model-generated title summarizing the
 * opening message (`openingPrompt`) of a live workspace whose opening
 * conversation runs a tool that titles nothing (`agentTitlesItself`), and
 * that has neither a user title nor an agent's. It goes in its own column,
 * which a user title and an agent's both outrank.
 *
 * Drafts and queued entries without a user title are titled from their
 * prompt the same way; the write only lands if the prompt is unchanged.
 * What is created from one keeps that title, until its agent gives one.
 *
 * Each tick fires detached tasks, so it never blocks on a model download or
 * inference (the summarizer serializes those). The in-memory `attempted` set
 * allows one attempt per workspace (or per draft/entry prompt) per server
 * run.
 */
import { createHash } from 'node:crypto'
import {
  getAgentSessionsFor,
  listDraftWorkspaceRows,
  listQueuedWorkspaceRows,
  listWorkspaceRows,
  setDraftWorkspaceTitle,
  setQueuedWorkspaceTitle,
  setWorkspaceGeneratedTitle,
} from '#db'
import { agentTitlesItself } from '#runtime/agents'
import { shouldGenerateTitle, summarizeTitle } from './title-summarizer'
import { errorText, serverLog } from '#lib/log'
import { env } from '@yaac/shared/env'

/** Keys already attempted this server run. */
const attempted = new Set<string>()

/** A draft's or entry's key: its id and a hash of its prompt, which can run
 *  to `MAX_PROMPT_LENGTH` and would otherwise be held here for good. */
const promptKey = (kind: string, id: string, prompt: string): string =>
  `${kind}:${id}:${createHash('sha256').update(prompt).digest('base64url')}`

/** Sweep live workspaces, drafts and queued entries once, firing detached
 *  title-generation tasks. Reads only rows; the runtime isn't consulted. */
export async function reconcileGeneratedTitles(): Promise<void> {
  if (!env.autoTitles) return

  const untitled = (await listWorkspaceRows())
    .filter((r) => r.stoppedAt === undefined && r.title === undefined && r.generatedTitle === undefined)
  const sessions = await getAgentSessionsFor(untitled)
  for (const { projectId, workspaceId } of untitled) {
    const key = `${projectId}/${workspaceId}`
    const links = sessions.get(key) ?? []
    const opening = links.find((l) => l.firstPrompt !== undefined)
    if (opening?.firstPrompt === undefined || agentTitlesItself(opening.tool)) continue
    if (links.some((l) => l.title !== undefined)) continue
    void generateOnce(key, key, opening.firstPrompt, (t) => setWorkspaceGeneratedTitle(projectId, workspaceId, t))
  }
  // Drafts and entries are keyed on the prompt too, so an edited prompt gets
  // its own attempt.
  for (const { id, prompt, title, generatedTitle } of await listDraftWorkspaceRows()) {
    if (title !== undefined || generatedTitle !== undefined) continue
    void generateOnce(promptKey('draft', id, prompt), `draft ${id}`, prompt, (t) => setDraftWorkspaceTitle(id, prompt, t))
  }
  for (const { id, prompt, title, generatedTitle, launchWorkspaceId } of await listQueuedWorkspaceRows()) {
    if (title !== undefined || generatedTitle !== undefined || launchWorkspaceId !== undefined) continue
    void generateOnce(promptKey('queued', id, prompt), `queued ${id}`, prompt, (t) => setQueuedWorkspaceTitle(id, prompt, t))
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
    serverLog(`[titles] ${label}: ${errorText(err)}`)
  }
}

/** Test helper: forget which keys were already attempted. */
export function _resetTitleGenerationForTests(): void {
  attempted.clear()
}
