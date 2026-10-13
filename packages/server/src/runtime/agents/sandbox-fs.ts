import { constants as C } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { projectDir } from '@yaac/shared/project-paths'
import { workspacesSandboxed } from '#drivers/driver'
import { openAgentDir, type ConfinedRoot } from '#lib/confined-fs'

/** `dir` of `projectId`'s project, a dir agents can also write, opened as
 *  this runtime requires (`openAgentDir`). */
export function openSandboxDir(projectId: string, dir: string): Promise<ConfinedRoot> {
  return openAgentDir(projectDir(projectId), dir, workspacesSandboxed())
}

/** A file in one of those dirs: the dir, and the path below it. */
export interface SandboxFile {
  projectId: string
  dir: string
  rel: string
}

/** A regular file's bytes, or null when there is none to read (see
 *  `ConfinedRoot.readFile`, which also says what too large does). */
export async function readSandboxFile(file: SandboxFile, maxBytes: number): Promise<Buffer | null> {
  const root = await openSandboxDir(file.projectId, file.dir).catch(() => null)
  return root === null ? null : root.readFile(file.rel, { maxBytes })
}

/** A regular file opened for reading, or null when there is none. */
export async function openSandboxFile(file: SandboxFile): Promise<FileHandle | null> {
  try {
    return await (await openSandboxDir(file.projectId, file.dir)).open(file.rel, C.O_RDONLY)
  } catch {
    return null
  }
}
