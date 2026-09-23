import type { ChangeStatus, FileStatus } from '@yaac/shared/types'

/**
 * The git status palette, shared by the Changes pane (what differs from the
 * fork base) and the file explorer (what differs from HEAD): a one-letter
 * badge and the color it and the file's name take.
 */
export interface StatusMeta {
  letter: string
  className: string
}

const GREEN = 'text-[#3fb950]'
const YELLOW = 'text-[#d29922]'
const RED = 'text-[#f85149]'
const BLUE = 'text-[#58a6ff]'

export const CHANGE_STATUS: Record<ChangeStatus, StatusMeta> = {
  added: { letter: 'A', className: GREEN },
  modified: { letter: 'M', className: YELLOW },
  deleted: { letter: 'D', className: RED },
  renamed: { letter: 'R', className: BLUE },
  copied: { letter: 'C', className: BLUE },
  typechange: { letter: 'T', className: 'text-text-dim' },
}

export const FILE_STATUS: Record<FileStatus, StatusMeta> = {
  modified: { letter: 'M', className: YELLOW },
  added: { letter: 'A', className: GREEN },
  untracked: { letter: 'U', className: GREEN },
  conflicted: { letter: '!', className: RED },
}

/** Strongest first: a folder shows the strongest status among what it holds. */
export const FILE_STATUS_RANK: FileStatus[] = ['conflicted', 'modified', 'added', 'untracked']
