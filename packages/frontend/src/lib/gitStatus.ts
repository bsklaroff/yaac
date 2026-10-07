import type { ChangeStage, ChangeStatus, LineCounts, WorkspaceChange } from '@yaac/shared/types'

/**
 * The git status palette for the explorer. A file's name takes the color of
 * how it differs from the diff base (or of a merge conflict), and its badge
 * a letter per stage its changes sit in.
 */
export type RowStatus = ChangeStatus | 'conflicted'

const GREEN = 'text-success'
const YELLOW = 'text-warning'
const RED = 'text-error'
const BLUE = 'text-link'
const PURPLE = 'text-purple'

/** The color a file's name (or a folder's dot) takes for its status. */
export const ROW_STATUS: Record<RowStatus, string> = {
  conflicted: RED,
  added: GREEN,
  modified: YELLOW,
  deleted: RED,
  renamed: BLUE,
  copied: BLUE,
  typechange: 'text-text-dim',
}

/** Strongest first: a folder shows the strongest status among what it holds. */
const RANK: RowStatus[] = ['conflicted', 'modified', 'deleted', 'typechange', 'renamed', 'copied', 'added']

/**
 * Each changed file's status, and each folder holding one the strongest
 * status among its files. A conflict outranks how the file differs from the
 * base.
 */
export function pathStatuses(changes: WorkspaceChange[], conflicted: string[]): Map<string, RowStatus> {
  const out = new Map<string, RowStatus>()
  const mark = (path: string, status: RowStatus): void => {
    out.set(path, status)
    for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
      const dir = path.slice(0, i)
      const held = out.get(dir)
      if (held !== undefined && RANK.indexOf(held) <= RANK.indexOf(status)) break
      out.set(dir, status)
    }
  }
  for (const c of changes) mark(c.path, c.status)
  for (const path of conflicted) mark(path, 'conflicted')
  return out
}

/** The stages a change can sit in, oldest first, with their labels and
 *  badge letters (`M` for modified, as VS Code marks a working-tree edit). */
export const CHANGE_STAGES: { stage: ChangeStage; label: string; letter: string; className: string }[] = [
  { stage: 'committed', label: 'committed', letter: 'C', className: BLUE },
  { stage: 'staged', label: 'staged', letter: 'S', className: GREEN },
  { stage: 'modified', label: 'modified', letter: 'M', className: YELLOW },
  { stage: 'untracked', label: 'untracked', letter: 'U', className: PURPLE },
]

/** The line counts of `files`, summed. */
export function lineTotals(files: WorkspaceChange[]): LineCounts {
  return files.reduce(
    (a, f) => ({ additions: a.additions + f.additions, deletions: a.deletions + f.deletions }),
    { additions: 0, deletions: 0 },
  )
}

/** Line counts per stage, summed over `files`; a stage no file has is absent. */
export function stageTotals(files: WorkspaceChange[]): Partial<Record<ChangeStage, LineCounts>> {
  const out: Partial<Record<ChangeStage, LineCounts>> = {}
  for (const f of files) {
    for (const { stage } of CHANGE_STAGES) {
      const c = f.stages[stage]
      if (!c) continue
      const t = out[stage] ?? { additions: 0, deletions: 0 }
      out[stage] = { additions: t.additions + c.additions, deletions: t.deletions + c.deletions }
    }
  }
  return out
}
