/**
 * yaac's own bundled skills — `builtin-skills/<name>/SKILL.md` dirs shipped
 * inside the yaac package that yaac injects into *every* worktree's personal
 * skills root, for every agent tool.
 *
 * Delivery is per substrate, and both deliveries put something at the same
 * name — `<root>/<name>` in every tool's shared skills root — which is why
 * `reconcileSharedSkillRoots` owns both and can convert either into the other.
 *
 * A pod gets a per-worktree read-only mount: at worktree create the packaged
 * skills are copied into a staging dir under the worktree dir
 * (`stageBuiltinSkills`) and each is mounted at `<root>/<name>`
 * (`builtinSkillMounts`). Copying fresh from the install on every create keeps
 * the staged skills in lockstep with the running yaac version, and because the
 * content rides in via the mount it never lands in the persisted per-project
 * config dirs — so nothing ever goes stale there. The staging dir is removed
 * with the worktree dir on cleanup. The `mountpoint` delivery makes each
 * `<root>/<name>` first, so the SERVER owns those directories: a mountpoint the
 * kubelet has to create is created root-owned, which no later run can clear.
 *
 * A containerless worktree has no mount namespace to layer that staging over
 * its tool homes (which are symlinks into the project's shared config dirs),
 * so the `link` delivery symlinks each skill once per PROJECT into those
 * shared skills roots, pointing at the install dir itself. Shared across the
 * project's worktrees is that substrate's honest scope — the same bargain as
 * its real credentials: there is no boundary that could make it narrower.
 *
 * An install can switch substrates, so each delivery has to converge the roots
 * from whatever the other left: a spent mountpoint (an empty directory) where a
 * link belongs, a link of ours where a mountpoint belongs. Both run on every
 * create AND every restart, so a switched install heals per project on first
 * use with no migration to schedule.
 *
 * Discovery (discover.ts) reads the install dir directly — it runs pod-less, so
 * it can't see the in-pod mounts — and surfaces these as `system`/`yaac` skills
 * with full SKILL.md detail.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import {
  PACKAGE_ROOT, claudeDir, codexDir, opencodeConfigDir, piDir,
} from '@yaac/shared/project-paths'
import { serverLog } from '#log'
import type { WorkspaceMount } from '#drivers/contract'

/** The dir name this feature ships from, under the package root. It is also
 *  what marks a link in a skills root as one of ours: a link into a dir of
 *  this name is a builtin, whoever's install put it there. */
const BUILTIN_DIR_NAME = 'builtin-skills'

/**
 * In-pod personal skills root for each agent tool. yaac's bundled skills are
 * mounted at `<root>/<name>` in every one — not just the active tool's — so a
 * prewarmed spare retooled to any tool at claim time already has them (mounts
 * are fixed at pod create). Mirrors the per-tool `personal` readers in
 * discover.ts.
 */
export const TOOL_SKILL_ROOTS = [
  '/home/yaac/.claude/skills',
  '/home/yaac/.codex/skills',
  '/home/yaac/.config/opencode/skills',
  '/home/yaac/.pi/agent/skills',
] as const

let sourceDirOverride: string | null = null

/**
 * Directory holding yaac's shipped `<name>/SKILL.md` skills — `builtin-skills/`
 * under the package root (copied into `dist/` by the build, so this resolves
 * in dev/test and in the published CLI). Overridable in tests via
 * `setBuiltinSkillsDir`.
 */
export function builtinSkillsDir(): string {
  return sourceDirOverride ?? path.join(PACKAGE_ROOT, BUILTIN_DIR_NAME)
}

/**
 * Each tool's personal skills root on the HOST — the per-project config dirs
 * a pod mounts at `TOOL_SKILL_ROOTS`, which the containerless driver links
 * into a workspace's home instead. Same four tools, same reason to write all
 * four regardless of the active one.
 */
export function sharedSkillRoots(slug: string): string[] {
  return [
    path.join(claudeDir(slug), 'skills'),
    path.join(codexDir(slug), 'skills'),
    path.join(opencodeConfigDir(slug), 'skills'),
    path.join(piDir(slug), 'agent', 'skills'),
  ]
}

/** Point discovery + staging at a different builtin-skills dir (tests). Pass
 *  null to restore the packaged default. */
export function setBuiltinSkillsDir(dir: string | null): void {
  sourceDirOverride = dir
}

/** The `<name>` subdirs of `dir` that hold a `SKILL.md`, sorted. A missing or
 *  unreadable dir (no bundled skills shipped, e.g. a stripped build) → []. */
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

/** Copy every skill dir from `srcDir` into `destDir` (replacing any prior
 *  staging) and return the staged skill names. A fresh copy per worktree keeps
 *  the staged skills in lockstep with the installed yaac version. */
export async function stageBuiltinSkills(srcDir: string, destDir: string): Promise<string[]> {
  await fs.rm(destDir, { recursive: true, force: true })
  const names = await listBuiltinSkills(srcDir)
  for (const name of names) {
    await fs.cp(path.join(srcDir, name), path.join(destDir, name), { recursive: true })
  }
  return names
}

/**
 * Whether `entry` is a link this feature planted: a symlink whose raw target's
 * immediate parent is a builtin-skills dir — this install's, or any dir of
 * that name. The link is never resolved and the match is on that one path
 * component, so a real directory of that name, a target merely passing through
 * such a segment, and a checkout whose path contains the string are all
 * correctly not ours.
 *
 * Ownership is deliberately per machine rather than scoped to this install's
 * root, because a versioned global install moves on every upgrade and its
 * links are recognizable by nothing else — scoping tighter would orphan them
 * in the user's config dir forever. What that breadth costs is a link of the
 * user's OWN aimed into a dir they happened to name `builtin-skills`, which
 * this claims and re-aims or prunes. The loss is bounded to the link: `fs.rm`
 * does not follow one, so whatever it pointed at is untouched.
 *
 * This is the whole ownership record. Nothing else in a shared skills root is
 * ours, so nothing else is ever rewritten or removed there.
 */
export async function isBuiltinSkillLink(entry: string): Promise<boolean> {
  const target = await fs.readlink(entry).catch(() => null)
  if (target === null) return false // not a symlink, or gone
  const parent = path.dirname(target)
  return parent === builtinSkillsDir() || path.basename(parent) === BUILTIN_DIR_NAME
}

/**
 * How this substrate delivers a builtin skill to `<root>/<name>`: a symlink
 * into the install (containerless, which has no mount namespace), or an empty
 * directory for a pod to mount its per-worktree staging over (k8s).
 */
export type SkillDelivery = 'link' | 'mountpoint'

/**
 * Converge a project's shared skills roots on `delivery`, and answer with the
 * names this install ships.
 *
 * Per project rather than per worktree because the roots themselves are
 * per-project: the tool homes a workspace gets are mounts or links into these
 * dirs. Under `link` the skills track the running yaac version with nothing on
 * disk to go stale; under `mountpoint` the content rides in on the mount, so
 * the directory left here is empty by design.
 *
 * Only what is OURS is ever touched, whichever delivery runs. A name the user
 * owns — a real skill directory or a file, or a link of their own aimed
 * outside a builtin-skills dir (`isBuiltinSkillLink` states the one exception)
 * — is left exactly as it is, so a personal skill wins its name. A link of
 * ours pointing at the wrong place (the install moved) is re-aimed, and one
 * whose skill is no longer shipped (retired between versions) is removed,
 * which is the only way it would ever leave.
 *
 * The other delivery's leavings are ours too, since an install may switch
 * substrates: `link` reclaims a spent mountpoint, `mountpoint` converts a link
 * of ours back. Both claim only a name this install SHIPS — an unshipped
 * empty directory is left alone, because we have no use for that name and no
 * way to know it isn't a dir the user made to fill later.
 */
export async function reconcileSharedSkillRoots(
  srcDir: string, slug: string, delivery: SkillDelivery,
): Promise<string[]> {
  const names = await listBuiltinSkills(srcDir)
  for (const root of sharedSkillRoots(slug)) {
    await pruneRetiredLinks(root, names)
    if (names.length === 0) continue // a stripped build: create nothing
    await fs.mkdir(root, { recursive: true })
    for (const name of names) {
      const dest = path.join(root, name)
      if (delivery === 'link') await linkSkill(path.join(srcDir, name), dest)
      else await makeMountpoint(dest)
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
  // A real dir (or file) at this name is either the user's own skill — and
  // personal beats builtin, the collision `builtin-skills/README.md` warns
  // about, resolved in their favor rather than by overwriting their work — or
  // a mountpoint a pod run left behind, which holds no skill and is ours.
  if (!stat.isSymbolicLink()) {
    if (await reclaimSpentMountpoint(dest)) await plantLink(src, dest)
    return
  }
  if (await fs.readlink(dest).catch(() => null) === src) return
  if (!(await isBuiltinSkillLink(dest))) return // their link, their name
  await reaimLink(src, dest)
}

/**
 * Take the name back from a directory holding no skill, answering whether it
 * is now free.
 *
 * `rmdir` IS the test: it refuses a directory with anything in it, so the
 * user's own skill is safe without a separate emptiness check to race against,
 * and a file at the name refuses for the same reason. What is left is an empty
 * directory, which is not a skill by any reader's definition — under this
 * install it is a mountpoint a pod run created and this substrate cannot mount
 * over. Leaving it is what makes a builtin silently missing after a switch
 * from k8s, so it is reclaimed rather than deferred to.
 *
 * A pod run of this version leaves a SERVER-owned one (see the `mountpoint`
 * delivery), which is removable. Older ones the kubelet made are root-owned;
 * whether those go depends on the root's own permissions, so the failure is
 * reported with the path rather than passed over — nothing else will mention
 * it, and the symptom (one missing skill) points nowhere near the cause.
 */
async function reclaimSpentMountpoint(dest: string): Promise<boolean> {
  try {
    await fs.rmdir(dest)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return true // already gone: a concurrent create's
    // Theirs, and left alone in silence: a skill dir (ENOTEMPTY, or EEXIST
    // where the platform prefers it) or a file (ENOTDIR).
    if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR') return false
    // Anything else is a permission problem (EACCES, or EPERM on a sticky
    // parent) — the root-owned case, which must not pass in silence.
    serverLog(
      `[server] skills: cannot reclaim ${dest} left by a previous driver `
      + `(${String(code)}); yaac's "${path.basename(dest)}" skill will be missing `
      + 'from this project until it is removed',
    )
    return false
  }
}

/**
 * Make `dest` an empty directory for a pod to mount over, unless the name is
 * one the user owns there.
 *
 * The directory has to exist BEFORE the pod does. A mountpoint the kubelet
 * creates is root-owned, and then nothing running as the server can clear it —
 * which is precisely what strands a name when the install later switches to a
 * substrate that delivers by link.
 *
 * A link of ours at the name is the switch running the other way: it aims at
 * an install path no pod can resolve, so it is replaced. `fs.rm` does not
 * follow a symlink, so the install dir it pointed at is untouched.
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

/** Create one mountpoint, tolerating a concurrent create of the same project
 *  having just made it — the same race `plantLink` tolerates, for the same
 *  reason: both creates want the identical directory. */
async function mkdirMountpoint(dest: string): Promise<void> {
  try {
    await fs.mkdir(dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
}

/**
 * Create one link, tolerating a concurrent create of the same project having
 * just planted it. Two worktree creates run this sweep against the same
 * shared roots with the same desired state, so losing that race means the
 * link is already there — never a reason to fail a worktree create.
 */
async function plantLink(src: string, dest: string): Promise<void> {
  try {
    await fs.symlink(src, dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
}

/** A per-process counter, so two re-aims in flight at once cannot pick the
 *  same staging name. Across processes the pid separates them. */
let reaimSeq = 0

/**
 * Re-point an existing link of ours, without the name ever going missing.
 * Removing and re-creating would leave a window in which an agent enumerating
 * its skills right then finds the skill gone; a rename over the old link
 * replaces it in one step instead. The staging link is in the same directory,
 * because rename is only atomic within a filesystem, and dot-prefixed so the
 * same window cannot instead offer it as an extra skill: `listBuiltinSkills`
 * skips dot names outright, and discovery's personal tier hides it as a link
 * of ours. A crash between the two steps leaves one behind, which the next
 * create's prune removes — it is a link of ours under a name this install
 * does not ship.
 *
 * Which is also why a vanished staging link is not an error. That same
 * description matches it while it is still in use, so a concurrent create of
 * this project can prune it out from under this rename; that create is
 * running the same reconcile toward the same desired state, so it converges
 * `dest` itself. Losing the race is never a reason to fail a worktree create.
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
async function pruneRetiredLinks(root: string, names: string[]): Promise<void> {
  const entries = await fs.readdir(root).catch(() => null)
  if (!entries) return
  const shipped = new Set(names)
  for (const entry of entries) {
    if (shipped.has(entry)) continue
    const abs = path.join(root, entry)
    if (await isBuiltinSkillLink(abs)) await fs.rm(abs, { force: true })
  }
}

/** Read-only mounts placing each staged skill at `<root>/<name>` in every
 *  tool's personal skills dir. The skill content rides in via the mount, so it
 *  is never written into the persisted per-project config dirs. The staging dir
 *  is SHARED (under `worktreeStateDir`) — server-written, pod-read — so it takes the
 *  shared tier's source. */
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
