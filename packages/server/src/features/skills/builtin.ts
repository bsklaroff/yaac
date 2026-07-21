/**
 * yaac's own bundled skills — `builtin-skills/<name>/SKILL.md` dirs shipped
 * inside the yaac package that yaac injects into *every* session's personal
 * skills root, for every agent tool.
 *
 * Delivery is a per-session read-only mount, never a write into a config dir:
 * at session create the packaged skills are copied into a staging dir under
 * the session dir (`stageBuiltinSkills`) and each is mounted at `<root>/<name>`
 * in every tool's personal skills dir (`builtinSkillMounts`). Copying fresh
 * from the install on every create keeps the staged skills in lockstep with
 * the running yaac version, and because the content rides in via the mount it
 * never lands in the persisted per-project config dirs — so nothing ever goes
 * stale there. The staging dir is removed with the session dir on cleanup.
 *
 * Discovery (lib/skills/discover.ts) reads the install dir directly — it runs
 * pod-less, so it can't see the in-pod mounts — and surfaces these as
 * `system`/`yaac` skills with full SKILL.md detail.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { PACKAGE_ROOT } from '@yaac/shared/project-paths'
import type { HostPathMount } from '#platform/k8s/pod-spec'

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
  return sourceDirOverride ?? path.join(PACKAGE_ROOT, 'builtin-skills')
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
 *  staging) and return the staged skill names. A fresh copy per session keeps
 *  the staged skills in lockstep with the installed yaac version. */
export async function stageBuiltinSkills(srcDir: string, destDir: string): Promise<string[]> {
  await fs.rm(destDir, { recursive: true, force: true })
  const names = await listBuiltinSkills(srcDir)
  for (const name of names) {
    await fs.cp(path.join(srcDir, name), path.join(destDir, name), { recursive: true })
  }
  return names
}

/** Read-only hostPath mounts placing each staged skill at `<root>/<name>` in
 *  every tool's personal skills dir. The skill content rides in via the mount,
 *  so it is never written into the persisted per-project config dirs. */
export function builtinSkillMounts(stagingDir: string, names: string[]): HostPathMount[] {
  const mounts: HostPathMount[] = []
  for (const name of names) {
    for (const root of TOOL_SKILL_ROOTS) {
      mounts.push({ hostPath: path.join(stagingDir, name), mountPath: `${root}/${name}`, readOnly: true })
    }
  }
  return mounts
}
