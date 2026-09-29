import { constants as C } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { projectDir } from '@yaac/shared/project-paths'
import { hasWorktreeDriver, worktreeDriver } from '#drivers/driver'
import { openRoot, type ConfinedRoot, type LinkPolicy } from '#lib/confined-fs'

/**
 * How the server touches a project dir an agent writes too: a tool home
 * (`claude/`, `codex/`, `pi/`, `opencode-config/`) or a worktree's
 * conversation records (`acp/<worktreeId>/`).
 *
 * Under a sandboxing runtime every pod of the project mounts these
 * read-write, so anything below a mount root may be a link or a FIFO the pod
 * planted: they are opened `no-links`, rooted at the dir itself — a mount
 * root, which the pod cannot replace. Under containerless there is no
 * boundary to defend, and links there are yaac's own (a worktree's history
 * and builtin skills are linked in), so they are opened `inside`, rooted at
 * the project dir.
 *
 * The one driver-kind branch confinement takes, and it decides only whether
 * confinement applies. No driver registered reads as sandboxed, the
 * conservative answer.
 */
export function sandboxLinkPolicy(): LinkPolicy {
  return hasWorktreeDriver() && worktreeDriver().kind === 'containerless' ? 'inside' : 'no-links'
}

/** `dir` of `slug`'s project, opened as `sandboxLinkPolicy` says. Paths are
 *  taken relative to `dir` either way. */
export function openSandboxDir(slug: string, dir: string): Promise<ConfinedRoot> {
  return sandboxLinkPolicy() === 'inside'
    ? openRoot(projectDir(slug), 'inside', { base: dir })
    : openRoot(dir, 'no-links')
}

/** A file in one of those dirs: the dir, and the path below it. */
export interface SandboxFile {
  slug: string
  dir: string
  rel: string
}

/** A regular file's bytes, or null when there is none to read (see
 *  `ConfinedRoot.readFile`, which also says what too large does). */
export async function readSandboxFile(file: SandboxFile, maxBytes: number): Promise<Buffer | null> {
  const root = await openSandboxDir(file.slug, file.dir).catch(() => null)
  return root === null ? null : root.readFile(file.rel, { maxBytes })
}

/** A regular file opened for reading, or null when there is none. */
export async function openSandboxFile(file: SandboxFile): Promise<FileHandle | null> {
  try {
    return await (await openSandboxDir(file.slug, file.dir)).open(file.rel, C.O_RDONLY)
  } catch {
    return null
  }
}
