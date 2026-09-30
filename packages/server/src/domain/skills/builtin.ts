/**
 * yaac's built-in skills: `builtin-skills/<name>/SKILL.md` dirs shipped in
 * the package and delivered into every workspace's personal skills root for
 * every agent tool, at `<root>/<name>`.
 *
 * k8s (`mountpoint` delivery): at create, the skills are copied into the
 * workspace's state dir (`stageBuiltinSkills`) and each is mounted read-only
 * at `<root>/<name>` (`builtinSkillMounts`). A fresh copy per create matches
 * the running yaac version, and nothing is written into the persisted
 * per-project config dirs. The server creates each mountpoint directory
 * first, since one the kubelet creates is root-owned and can't be cleared.
 *
 * containerless (`link` delivery): there are no mounts, so each skill is
 * symlinked once per project into the shared skills roots, pointing at the
 * install dir. Project-wide scope is the best this substrate can do.
 *
 * An install can switch substrates, so `reconcileSharedSkillRoots` converts
 * whatever the other delivery left (an empty mountpoint, or our link). It
 * runs on every create and restart, so no migration is needed.
 *
 * Discovery (discover.ts) reads the install dir directly, since it can't see
 * in-pod mounts.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import {
  PACKAGE_ROOT, claudeDir, codexDir, opencodeConfigDir, piDir,
} from '@yaac/shared/project-paths'
import type { WorkspaceMount } from '#drivers/contract'
import type { PinnedDir } from '#lib/confined-fs'
import { openSandboxDir } from '#runtime/agents'

/** The package dir the skills ship in. A link into any dir with this name is
 *  treated as ours (see `isBuiltinSkillLink`). */
const BUILTIN_DIR_NAME = 'builtin-skills'

/**
 * In-pod personal skills root for each agent tool. Skills are mounted in all
 * of them, not just the active tool's, because mounts are fixed at pod
 * create and a spare may be claimed for any tool. Mirrors the per-tool
 * `personal` readers in discover.ts.
 */
export const TOOL_SKILL_ROOTS = [
  '/home/yaac/.claude/skills',
  '/home/yaac/.codex/skills',
  '/home/yaac/.config/opencode/skills',
  '/home/yaac/.pi/agent/skills',
] as const

let sourceDirOverride: string | null = null

/**
 * The directory of shipped `<name>/SKILL.md` skills: `builtin-skills/` under
 * the package root (the build copies it into `dist/`). Overridable in tests
 * via `setBuiltinSkillsDir`.
 */
export function builtinSkillsDir(): string {
  return sourceDirOverride ?? path.join(PACKAGE_ROOT, BUILTIN_DIR_NAME)
}

/**
 * Each tool's personal skills root on the host: the per-project config dirs
 * a pod mounts at `TOOL_SKILL_ROOTS` (containerless links them instead). All
 * four tools, regardless of the active one.
 */
export function sharedSkillRoots(slug: string): string[] {
  return SKILL_HOMES.map(([home, rel]) => path.join(home(slug), rel))
}

/** Each root as (tool home, path within it). */
const SKILL_HOMES: ReadonlyArray<readonly [home: (slug: string) => string, rel: string]> = [
  [claudeDir, 'skills'],
  [codexDir, 'skills'],
  [opencodeConfigDir, 'skills'],
  [piDir, 'agent/skills'],
]

/** Point discovery + staging at a different builtin-skills dir (tests). Pass
 *  null to restore the packaged default. */
export function setBuiltinSkillsDir(dir: string | null): void {
  sourceDirOverride = dir
}

/** The `<name>` subdirs of `dir` that hold a `SKILL.md`, sorted; [] if `dir`
 *  is missing or unreadable. */
export async function listBuiltinSkills(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null)
  if (!entries) return []
  const names: string[] = []
  for (const e of entries) {
    if (!(e.isDirectory() || e.isSymbolicLink()) || e.name.startsWith('.')) continue
    const hasSkill = await fs.access(path.join(dir, e.name, 'SKILL.md')).then(() => true, () => false)
    if (hasSkill) names.push(e.name)
  }
  return names.sort()
}

/** Copy every skill dir from `srcDir` into `destDir`, replacing any prior
 *  staging, and return the staged names. */
export async function stageBuiltinSkills(srcDir: string, destDir: string): Promise<string[]> {
  await fs.rm(destDir, { recursive: true, force: true })
  const names = await listBuiltinSkills(srcDir)
  for (const name of names) {
    await fs.cp(path.join(srcDir, name), path.join(destDir, name), { recursive: true })
  }
  return names
}

/**
 * Whether `entry` is a link we planted: a symlink whose raw target's
 * immediate parent is this install's builtin-skills dir or any dir with that
 * name. The link is never resolved and only that one path component is
 * matched.
 *
 * Any `builtin-skills` dir counts, not just this install's, because a
 * versioned global install moves on every upgrade and its old links would
 * otherwise be orphaned. The cost: a user's own link into a dir named
 * `builtin-skills` may be re-aimed or pruned (only the link; `fs.rm` doesn't
 * follow it).
 *
 * This is the only ownership test; nothing else in a shared skills root is
 * ever changed.
 */
export async function isBuiltinSkillLink(entry: string): Promise<boolean> {
  const target = await fs.readlink(entry).catch(() => null)
  if (target === null) return false // not a symlink, or gone
  const parent = path.dirname(target)
  return parent === builtinSkillsDir() || path.basename(parent) === BUILTIN_DIR_NAME
}

/**
 * How a builtin skill reaches `<root>/<name>`: a symlink into the install
 * (containerless), or an empty directory a pod mounts the staged copy over
 * (k8s).
 */
export type SkillDelivery = 'link' | 'mountpoint'

/**
 * Bring a project's shared skills roots in line with `delivery`, and return
 * the shipped skill names. Per project because the roots are per project.
 *
 * Only our own entries are touched: a user's skill directory, file or link
 * keeps its name. Our links are re-aimed if the install moved and removed if
 * the skill is no longer shipped.
 *
 * Leftovers from the other delivery are converted (`link` reclaims an empty
 * mountpoint; `mountpoint` replaces our link), but only for shipped names;
 * an unshipped empty directory may be the user's.
 */
export async function reconcileSharedSkillRoots(
  srcDir: string, slug: string, delivery: SkillDelivery,
): Promise<string[]> {
  const names = await listBuiltinSkills(srcDir)
  for (const [homeOf, rel] of SKILL_HOMES) {
    // With nothing shipped, create nothing; only prune existing roots.
    if (names.length > 0) await fs.mkdir(homeOf(slug), { recursive: true })
    const home = await openSandboxDir(slug, homeOf(slug)).catch(() => null)
    if (home === null) continue
    if (names.length > 0) await home.mkdirp(rel)
    // All operations below go through the pinned root, so a pod that swaps
    // the skills dir for a link can't redirect them.
    const root = await home.dir(rel).catch(() => null)
    if (root === null) continue
    try {
      await pruneRetiredLinks(root, names)
      for (const name of names) {
        const dest = root.child(name)
        if (delivery === 'link') await linkSkill(path.join(srcDir, name), dest)
        else await makeMountpoint(dest)
      }
    } finally {
      await root.close()
    }
  }
  return names
}

/** Point `dest` at `src`, unless the name is one the user owns there. */
async function linkSkill(src: string, dest: string): Promise<void> {
  const stat = await fs.lstat(dest).catch(() => null)
  if (stat === null) {
    await plantLink(src, dest)
    return
  }
  // A real dir or file here is either the user's own skill, which wins (see
  // `builtin-skills/README.md`), or an empty mountpoint left by a pod run,
  // which we reclaim.
  if (!stat.isSymbolicLink()) {
    if (await reclaimSpentMountpoint(dest)) await plantLink(src, dest)
    return
  }
  if (await fs.readlink(dest).catch(() => null) === src) return
  if (!(await isBuiltinSkillLink(dest))) return // their link, their name
  await reaimLink(src, dest)
}

/**
 * Remove an empty directory at `dest` and return whether the name is free.
 * `rmdir` fails on anything non-empty (or a file), so the user's skill is
 * safe without a racy emptiness check. An empty directory is a mountpoint
 * left by a k8s run; leaving it would hide the builtin after a switch.
 */
async function reclaimSpentMountpoint(dest: string): Promise<boolean> {
  try {
    await fs.rmdir(dest)
    return true
  } catch (err) {
    // Already gone (a concurrent create) means free; anything else is theirs.
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/**
 * Make `dest` an empty directory for a pod to mount over, unless the user
 * owns the name. It must exist before the pod, since a kubelet-created
 * mountpoint is root-owned and the server couldn't clear it after a switch
 * to link delivery. Our link at the name (from containerless) is replaced;
 * `fs.rm` doesn't follow it.
 */
async function makeMountpoint(dest: string): Promise<void> {
  const stat = await fs.lstat(dest).catch(() => null)
  if (stat === null) {
    await mkdirMountpoint(dest)
    return
  }
  if (!stat.isSymbolicLink()) return // their skill, or a mountpoint already
  if (!(await isBuiltinSkillLink(dest))) return // their link, their name
  await fs.rm(dest, { force: true })
  await mkdirMountpoint(dest)
}

/** Create one mountpoint, tolerating a concurrent create that just made it
 *  (as `plantLink` does). */
async function mkdirMountpoint(dest: string): Promise<void> {
  try {
    await fs.mkdir(dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
}

/** Create one link, tolerating a concurrent create of the same project that
 *  just planted the same link. */
async function plantLink(src: string, dest: string): Promise<void> {
  try {
    await fs.symlink(src, dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
}

/** Per-process counter for unique staging names (the pid separates
 *  processes). */
let reaimSeq = 0

/**
 * Re-point one of our links atomically, by renaming a new link over it, so
 * an agent listing skills never sees the name missing. The staging link sits
 * in the same directory (rename is atomic only within a filesystem) with a
 * dot prefix so it is never listed as a skill. A crash leaves it behind for
 * the next prune.
 *
 * A concurrent create may prune the staging link first; that create
 * converges `dest` itself, so ENOENT is not an error.
 */
async function reaimLink(src: string, dest: string): Promise<void> {
  reaimSeq += 1
  const staging = path.join(
    path.dirname(dest),
    `.${path.basename(dest)}.yaac-${String(process.pid)}-${String(reaimSeq)}`,
  )
  await fs.symlink(src, staging)
  try {
    await fs.rename(staging, dest)
  } catch (err) {
    await fs.rm(staging, { force: true })
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/** Remove our links in `root` for skills this install no longer ships. */
async function pruneRetiredLinks(root: PinnedDir, names: string[]): Promise<void> {
  const shipped = new Set(names)
  for (const entry of await fs.readdir(root.self)) {
    if (shipped.has(entry)) continue
    const abs = root.child(entry)
    if (await isBuiltinSkillLink(abs)) await fs.rm(abs, { force: true })
  }
}

/** Read-only mounts placing each staged skill at `<root>/<name>` in every
 *  tool's personal skills dir. The staging dir is under `workspaceStateDir`
 *  (server-written, pod-read). */
export function builtinSkillMounts(stagingDir: string, names: string[]): WorkspaceMount[] {
  const mounts: WorkspaceMount[] = []
  for (const name of names) {
    for (const root of TOOL_SKILL_ROOTS) {
      mounts.push({
        source: { kind: 'hostPath', path: path.join(stagingDir, name) },
        mountPath: `${root}/${name}`,
        readOnly: true,
      })
    }
  }
  return mounts
}
