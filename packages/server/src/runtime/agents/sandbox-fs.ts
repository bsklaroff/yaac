import { constants as C } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { projectDir } from '@yaac/shared/project-paths'
import { hasWorkspaceDriver, workspaceDriver } from '#drivers/driver'
import { openRoot, type ConfinedRoot, type LinkPolicy } from '#lib/confined-fs'

/**
 * How the server opens a project dir that agents can also write: a tool home
 * (`claude/`, `codex/`, `pi/`, `opencode-config/`) or a workspace's
 * conversation records (`acp/<workspaceId>/`).
 *
 * Under a sandboxing driver every pod of the project mounts these
 * read-write, so any link or FIFO below may be planted: they are opened
 * `no-links`, rooted at the mount root itself. Under containerless there is
 * nothing to defend and yaac itself links things in (history, builtin
 * skills), so they are opened `inside`, rooted at the project dir. With no
 * driver registered, the sandboxed answer is used.
 */
export function sandboxLinkPolicy(): LinkPolicy {
  return hasWorkspaceDriver() && workspaceDriver().kind === 'containerless' ? 'inside' : 'no-links'
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
