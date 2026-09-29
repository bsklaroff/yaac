/**
 * Reconcile step that gives otherwise-untitled sessions a model-generated
 * title summarizing their first user message, written to the same session
 * row as a user rename — a rename simply overwrites it, and only sessions
 * with no title at all are eligible, so a user's title is never clobbered.
 * Eligibility is checked again by the write itself: a rename that lands
 * while the model is still running wins.
 *
 * Draft worktrees are titled from their prompt the same way. A draft has no
 * rename; its title is cleared when its prompt changes, so the write is
 * conditional on the draft still holding the prompt it was made from.
 *
 * Each tick fires one detached task per eligible session — the tick body
 * never blocks on a model download or inference (those serialize inside
 * the summarizer). One attempt per session per server run, and per draft
 * prompt: the in-memory `attempted` set covers in-flight dedup, failure
 * memory, and don't-regenerate after a user deliberately clears a
 * generated title.
 */
import {
  firstAgentSessionsFor,
  listDraftWorktreeRows,
  listWorktreeRows,
  setDraftWorktreeTitle,
  setWorktreeTitle,
} from '#db'
import { shouldGenerateTitle, summarizeTitle } from './title-summarizer'
import { serverLog } from '#log'
import { env } from '@yaac/shared/env'

/** Sessions already handled this server run; added synchronously before the
 *  task's first await so a concurrent tick can't double-fire. */
const attempted = new Set<string>()

/** Sweep live worktrees and drafts once, firing detached title-generation
 *  tasks. The candidates are the rows alone — a title and a founding prompt
 *  are both recorded state, so there is nothing to ask the runtime. */
export async function reconcileGeneratedTitles(): Promise<void> {
  if (!env.autoTitles) return

  const untitled = (await listWorktreeRows())
    .filter((r) => r.stoppedAt === undefined && r.title === undefined)
  const firsts = await firstAgentSessionsFor(untitled)
  for (const { projectSlug, worktreeId } of untitled) {
    const key = `${projectSlug}/${worktreeId}`
    const prompt = firsts.get(key)?.firstPrompt
    if (prompt === undefined) continue
    void generateOnce(key, key, prompt, (t) => setWorktreeTitle(projectSlug, worktreeId, t, { ifUntitled: true }))
  }
  // A draft is keyed on its prompt too: editing the prompt clears the title,
  // and the new prompt is worth one attempt of its own.
  for (const { id, prompt, title } of await listDraftWorktreeRows()) {
    if (title !== undefined) continue
    void generateOnce(`draft:${id}:${prompt}`, `draft ${id}`, prompt, (t) => setDraftWorktreeTitle(id, prompt, t))
  }
}

/** One attempt per key. The claim is taken before the first await, so it
 *  lands synchronously in the sweep that fired it. */
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

/** Test helper: forget which sessions were already attempted. */
export function _resetTitleGenerationForTests(): void {
  attempted.clear()
}
