import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { parsePlanDoc, type ParsedPlanDoc } from '@/shared/plan-docs'
import type { PlanDocEntry } from '@/shared/types'

export { parsePlanDoc, updateFrontmatter } from '@/shared/plan-docs'

export interface ListedDoc {
  fileName: string
  parsed: ParsedPlanDoc
  updatedAt: number
  /** Content digest — lets the merge tell real per-session edits from
   *  the untouched copies every clone necessarily contains. */
  contentHash: string
}

export function hashDocContent(md: string): string {
  return crypto.createHash('sha1').update(md).digest('hex')
}

/**
 * List the markdown pages of one wiki clone. Wiki pages live flat at the
 * repo root; GitHub's special pages (_Sidebar, _Footer) and dotfiles are
 * skipped. Returns [] when the directory doesn't exist.
 */
export async function listDocsInDir(dir: string): Promise<ListedDoc[]> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: ListedDoc[] = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    const [md, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)])
    out.push({
      fileName: e.name,
      parsed: parsePlanDoc(md, e.name),
      updatedAt: stat.mtimeMs,
      contentHash: hashDocContent(md),
    })
  }
  return out
}

/**
 * Merge mirror docs with docs found in live sessions' working trees.
 * Every session clone contains the entire wiki, so a session copy only
 * counts as a draft when its content actually differs from the mirror's
 * — and then the newer mtime wins (another session may have already
 * pushed a later edit). `draftSessionId` records which session the
 * winning unpushed copy came from so the UI can render the freshest
 * content and embed its terminal.
 */
export function mergePlanDocs(
  mirror: ListedDoc[],
  perSession: Array<{ sessionId: string; docs: ListedDoc[] }>,
): PlanDocEntry[] {
  const byName = new Map<string, PlanDocEntry & { contentHash?: string }>()
  for (const d of mirror) {
    byName.set(d.fileName, {
      path: d.fileName,
      title: d.parsed.title,
      phase: d.parsed.phase,
      sessions: d.parsed.sessions,
      updatedAt: d.updatedAt,
      contentHash: d.contentHash,
    })
  }
  for (const { sessionId, docs } of perSession) {
    for (const d of docs) {
      const existing = byName.get(d.fileName)
      if (existing && existing.contentHash === d.contentHash) continue
      if (existing && existing.updatedAt > d.updatedAt) continue
      byName.set(d.fileName, {
        path: d.fileName,
        title: d.parsed.title,
        phase: d.parsed.phase,
        sessions: d.parsed.sessions,
        updatedAt: d.updatedAt,
        contentHash: d.contentHash,
        draftSessionId: sessionId,
      })
    }
  }
  return [...byName.values()]
    .map(({ contentHash: _hash, ...entry }) => entry)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}
