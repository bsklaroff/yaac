/**
 * The Commits pane's layout target and its commit graph: which column each
 * commit sits in and the lines joining it to its parents.
 *
 * Lanes are assigned walking the commits newest first. Each lane waits for
 * one commit, and a commit takes the lane waiting for it, so a branch keeps
 * one column (and one color) from its tip to its fork point. Its first
 * parent continues that lane; a merge's other parents join the lane already
 * waiting for them or open a new one. Lanes never shift sideways, so every
 * line runs straight except where a branch forks or merges.
 */
import type { GitLogCommit } from '@yaac/shared/types'

/** The one layout target of a workspace's Commits pane. */
export const COMMITS_TARGET = 'commits'

export function isCommitsTarget(target: string): boolean {
  return target === COMMITS_TARGET
}

/** A line across half a row, from a lane at one edge to a lane at the
 *  other; `color` indexes the palette. */
export interface GraphEdge {
  from: number
  to: number
  color: number
}

export interface GraphRow {
  /** The commit's column. */
  lane: number
  color: number
  /** Lines from the row's top into the commit, or straight past it. */
  top: GraphEdge[]
  /** Lines from the commit to its parents' lanes, or straight past it. */
  bottom: GraphEdge[]
}

/** Lay out `commits`, children before parents, as rows of one shared
 *  `width` in lanes. A parent missing from the list leaves its lane open to
 *  the bottom. */
export function layoutGraph(commits: Pick<GitLogCommit, 'sha' | 'parents'>[]): { rows: GraphRow[]; width: number } {
  const lanes: Array<{ sha: string; color: number } | null> = []
  let colors = 0
  let width = 1
  const free = (): number => {
    const i = lanes.indexOf(null)
    return i === -1 ? lanes.length : i
  }
  const rows = commits.map((c): GraphRow => {
    let lane = lanes.findIndex((l) => l?.sha === c.sha)
    if (lane === -1) lane = free()
    const color = lanes[lane]?.color ?? colors++
    const top = lanes.flatMap((l, j) => (l ? [{ from: j, to: l.sha === c.sha ? lane : j, color: l.color }] : []))
    lanes.forEach((l, j) => { if (l?.sha === c.sha) lanes[j] = null })
    // Lanes that ran past the commit carry on below it.
    const bottom: GraphEdge[] = top.filter((e) => e.from === e.to && e.from !== lane)
    for (const [i, p] of c.parents.entries()) {
      let k = i === 0 ? lane : lanes.findIndex((l) => l?.sha === p)
      if (i === 0) lanes[lane] = { sha: p, color }
      else if (k === -1) {
        k = free()
        lanes[k] = { sha: p, color: colors++ }
      }
      bottom.push({ from: lane, to: k, color: lanes[k]!.color })
    }
    while (lanes.length > 0 && lanes.at(-1) === null) lanes.pop()
    width = Math.max(width, lane + 1, ...top.map((e) => e.from + 1), ...bottom.map((e) => e.to + 1))
    return { lane, color, top, bottom }
  })
  return { rows, width }
}

/** A compare-picker value as the strip shows it: a local branch without
 *  its `refs/heads/`. */
export function branchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}
