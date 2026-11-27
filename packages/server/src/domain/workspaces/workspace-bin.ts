/**
 * In-workspace helper commands: the `workspace-bin/*` scripts shipped with
 * yaac (setup hook, yaac-mama, PR-watch and agent reporter hooks).
 *
 * A pod gets them from its server build's folder (`stageHelpers`), each
 * mounted read-only at `/usr/local/bin/<name>`, so they match the yaac
 * version that started it and the workspace cannot modify them. The same
 * folder carries the Go daemons a pod runs, streamd and acpd.
 * Containerless copies the commands per workspace (`stageWorkspaceBin`) and
 * symlinks them into the workspace's bin dir, so callers refer to them by
 * bare name.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { DAEMONS_DIR, PACKAGE_ROOT } from '@yaac/shared/project-paths'
import { globalPath } from '@yaac/shared/paths'
import { readBuildId } from '@yaac/shared/build-id'
import { env } from '@yaac/shared/env'
import { builtinSkillsDir, stageBuiltinSkills } from '#domain/skills'
import type { WorkspaceMount } from '#drivers/contract'

let sourceDirOverride: string | null = null

/**
 * `workspace-bin/` under the package root (the build copies it into `dist/`).
 * Overridable in tests via `setWorkspaceBinDir`.
 */
export function workspaceBinDir(): string {
  return sourceDirOverride ?? path.join(PACKAGE_ROOT, 'workspace-bin')
}

/** Point staging at a different workspace-bin dir (tests). Pass null to
 *  restore the packaged default. */
export function setWorkspaceBinDir(dir: string | null): void {
  sourceDirOverride = dir
}

/**
 * Copy every regular file from `srcDir` into a fresh `destDir`, make each
 * executable, and return the sorted names.
 */
export async function stageWorkspaceBin(srcDir: string, destDir: string): Promise<string[]> {
  await fs.rm(destDir, { recursive: true, force: true })
  const entries = await fs.readdir(srcDir, { withFileTypes: true })
  await fs.mkdir(destDir, { recursive: true })
  const names: string[] = []
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue
    const dest = path.join(destDir, e.name)
    await fs.copyFile(path.join(srcDir, e.name), dest)
    // Bind mounts keep host mode bits.
    await fs.chmod(dest, 0o755)
    names.push(e.name)
  }
  return names.sort()
}

/** Read-only mounts placing each staged script at `/usr/local/bin/<name>`. */
export function workspaceBinMounts(stagingDir: string, names: string[]): WorkspaceMount[] {
  return names.map((name) => ({
    source: { kind: 'hostPath', path: path.join(stagingDir, name), type: 'File' },
    mountPath: `/usr/local/bin/${name}`,
    readOnly: true,
  }))
}

/**
 * Copy the Linux builds of the Go daemons for this server's architecture
 * into `destDir`, as `streamd` and `acpd`, where the k8s driver starts them
 * (`HELPERS_DIR` in drivers/k8s/substrate/workspace-paths.ts). An install
 * builds its images on one machine for that machine's architecture, so its
 * nodes have the server's. A bundle without them fails here, by name, since
 * its pods would never answer; only a run from source, whose tiers start no
 * pod, may have none.
 */
async function stageDaemons(destDir: string): Promise<void> {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  await fs.mkdir(destDir, { recursive: true })
  for (const name of ['streamd', 'acpd']) {
    const src = path.join(DAEMONS_DIR, name, 'bin', `${name}-linux-${arch}`)
    const dest = path.join(destDir, name)
    await fs.copyFile(src, dest).then(
      () => fs.chmod(dest, 0o755),
      (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err
        if (env.bundled) throw new Error(`this build has no ${name} for linux-${arch} (${src}); \`pnpm build:daemons\` builds it`)
      },
    )
  }
}

/** What `stageHelpers` staged: its folder and what is in it. */
export interface StagedHelpers {
  binDir: string
  binNames: string[]
  skillsDir: string
  skillNames: string[]
}

let staged: Promise<StagedHelpers> | undefined

/** Test helper: stage again on the next call, for a new data dir. */
export function clearStagedHelpersForTests(): void {
  staged = undefined
}

/**
 * Stage this server build's helper commands, daemons and bundled skills
 * once, in a folder of the shared tier named for the build
 * (`run/helpers/<build>`), which every pod the build makes mounts read-only
 * from its creation, a spare included (docs/generic-workspace-pods.md "The
 * pod"). Running workspaces keep mounting the folder of the build that made
 * them, so it is written once and never changed.
 */
export function stageHelpers(): Promise<StagedHelpers> {
  staged ??= (async () => {
    const build = await readBuildId().catch(() => 'unbuilt')
    const dir = globalPath('run', 'helpers', build)
    const done = path.join(dir, '.staged')
    const binDir = path.join(dir, 'bin')
    const skillsDir = path.join(dir, 'skills')
    if (!await fs.access(done).then(() => true, () => false)) {
      const tmp = `${dir}.tmp-${String(process.pid)}`
      await fs.rm(tmp, { recursive: true, force: true })
      await stageWorkspaceBin(workspaceBinDir(), path.join(tmp, 'bin'))
      await stageDaemons(path.join(tmp, 'daemons'))
      await stageBuiltinSkills(builtinSkillsDir(), path.join(tmp, 'skills'))
      await fs.writeFile(path.join(tmp, '.staged'), '')
      await fs.rm(dir, { recursive: true, force: true })
      await fs.rename(tmp, dir)
    }
    const names = async (d: string, files: boolean): Promise<string[]> => (await fs.readdir(d, { withFileTypes: true }))
      .filter((e) => !e.name.startsWith('.') && (files ? e.isFile() : e.isDirectory())).map((e) => e.name).sort()
    return { binDir, binNames: await names(binDir, true), skillsDir, skillNames: await names(skillsDir, false) }
  })()
  staged.catch(() => { staged = undefined })
  return staged
}
