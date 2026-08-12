import {
  applyWorktreeEvent,
  getWorktreeRow,
  listProjectRows,
} from '#db'
import {
  deleteLegacyMetaFiles,
  readLegacyMetaDocuments,
  setAsideUnreadableMeta,
  type LegacyWorktreeMeta,
} from './meta-files'
import { serverLog } from '#log'

/**
 * Carry a previous yaac's per-worktree metadata documents into rows, once,
 * and delete them.
 *
 * Rows are the durable account of a worktree now (docs/worktree-storage.md).
 * Most of what the documents held is either already in a row or rediscoverable
 * from the session-starts log on the next tick — but two things are not, and
 * they are why this exists:
 *
 *  - **`spare`.** An unclaimed spare's flag is the only surviving record that
 *    its checkout was never a worktree. Lose it and the checkout is never
 *    collected, because no sweep can tell it from a stopped worktree.
 *  - **the life's log offset.** Without it the first fold after the upgrade
 *    reads the whole log as this pod's, and a pane id an earlier life
 *    recorded can be attributed to whichever live pane inherited its number.
 *
 * Everything it writes goes through the ordinary event door, so the same
 * fill-only and whole-set rules apply as to a discovery sweep — importing
 * twice is a no-op, which is what makes a half-finished import safe to retry.
 *
 * Recorded handles are deliberately NOT imported. A handle in a document
 * belonged to a pod of the previous server's making, and the frozen `active`
 * set a restart actually reads has been in rows all along; a pod still
 * running across the upgrade re-reports its panes on the next tick anyway.
 */
let imported = false

/** Test helper: let the once-per-server-life import run again. */
export function _resetLegacyMetaImportForTests(): void {
  imported = false
}

export async function importLegacyMeta(): Promise<void> {
  if (imported) return

  // The gate closes only once the project list is in hand. Closing it on
  // entry would turn a transient DB hiccup on the first pass into a whole
  // server life with no import — and until it runs, every worktree's
  // `lifeLogBytes` is 0, so the fold reads its entire log as the current
  // pod's and can attribute a dead pane to a live one. That window should be
  // one tick, not days.
  const projects = await listProjectRows().catch((err: unknown) => {
    serverLog(`[meta-import] could not list projects (${String(err)}); retrying next pass`)
    return undefined
  })
  if (projects === undefined) return
  imported = true
  for (const { slug } of projects) {
    try {
      const { documents, junk, unreadable } = await readLegacyMetaDocuments(slug)
      if (junk.length === 0 && documents.length === 0 && unreadable.length === 0) continue
      // Deleted one at a time, each after its own contents are in rows, so a
      // crash mid-project leaves the rest for the next start rather than
      // dropping documents it never imported. Re-importing one is free.
      for (const doc of documents) {
        await importDocument(slug, doc)
        await deleteLegacyMetaFiles([doc.file])
      }
      await deleteLegacyMetaFiles(junk)
      // Never deleted — see `setAsideUnreadableMeta`. Named in the log
      // because this is the only moment anyone finds out.
      if (unreadable.length > 0) {
        await setAsideUnreadableMeta(unreadable)
        serverLog(
          `[meta-import] ${slug}: could not read ${unreadable.length} document(s); `
          + `kept as <id>.json.bad (${unreadable.join(', ')})`,
        )
      }
      if (documents.length > 0) {
        serverLog(`[meta-import] ${slug}: imported ${documents.length} worktree document(s)`)
      }
    } catch (err) {
      serverLog(`[meta-import] ${slug}: ${String(err)}`)
    }
  }
}

async function importDocument(slug: string, doc: LegacyWorktreeMeta): Promise<void> {
  const worktreeId = doc.worktreeId
  const row = await getWorktreeRow(slug, worktreeId)

  // A spare only ever had a document — that was the whole point of the flag.
  // Recording one is therefore an INSERT, and it is guarded on there being no
  // row: a document claiming `spare` for something that already has a row is
  // a claim that landed in rows but whose document write was lost, and
  // re-flagging it would hand a real worktree to the reaper.
  if (doc.spare === true && row === undefined) {
    await applyWorktreeEvent({
      type: 'worktree-created',
      projectSlug: slug,
      worktreeId,
      spare: true,
      ...(doc.baseBranch !== undefined ? { baseBranch: doc.baseBranch } : {}),
    })
    return
  }
  // Nothing else is importable for a worktree with no row: its conversations
  // would link to a worktree no listing can show. The log survives, so a
  // worktree whose pod is still up is picked up by the ordinary sweep.
  if (row === undefined) return

  if (doc.sessions.length > 0) {
    await applyWorktreeEvent({
      type: 'sessions-discovered',
      projectSlug: slug,
      worktreeId,
      // In document order, which is first-seen order — the order ordinals are
      // assigned in, and so the order a restart brings windows back up in.
      sessions: doc.sessions.map((s) => ({
        tool: s.tool,
        agentSessionId: s.agentSessionId,
        mode: s.mode,
        firstSeenMs: s.firstSeenMs,
        ...(s.transcriptPath !== undefined ? { transcriptPath: s.transcriptPath } : {}),
        ...(s.firstPrompt !== undefined ? { firstPrompt: s.firstPrompt } : {}),
      })),
    })
  }

  // The fold boundary. Stamped as a life start because that is exactly what
  // it is — the pod that owns this offset is the one still running, if any —
  // and the pane clear it carries is a no-op on rows that never had one.
  if (doc.life !== undefined) {
    await applyWorktreeEvent({
      type: 'worktree-life-started',
      projectSlug: slug,
      worktreeId,
      logBytes: doc.life.logBytes,
    })
  }
}
