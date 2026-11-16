import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const built = new Map<string, Promise<string>>()

/**
 * Build one of the server's self-contained programs as the release build
 * does (tsup.helpers.config.ts), into a folder of its own a test can put on
 * PATH. Built once per test process.
 */
function buildHelper(name: string, entry: string): Promise<string> {
  let dir = built.get(name)
  if (!dir) {
    dir = (async () => {
      const out = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`))
      const outfile = path.join(out, name)
      await build({
        entryPoints: [fileURLToPath(new URL(`../../server/src/${entry}`, import.meta.url))],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        logLevel: 'error',
        banner: { js: '#!/usr/bin/env node' },
      })
      await fs.chmod(outfile, 0o755)
      return out
    })()
    built.set(name, dir)
  }
  return dir
}

/** The file editor's in-workspace helper, `yaac-files`; resolves to its folder. */
export const buildFilesHelper = (): Promise<string> => buildHelper('yaac-files', 'domain/workspaces/tree-helper.ts')

/** The tree container's program, `yaac-tree`; resolves to its path. */
export const buildTreeScript = async (): Promise<string> =>
  path.join(await buildHelper('yaac-tree', 'drivers/k8s/workspaces/tree/script.ts'), 'yaac-tree')

/** The per-node disk pod's program, `yaac-disk.mjs`; resolves to its path. */
export const buildDiskProgram = async (): Promise<string> =>
  path.join(await buildHelper('yaac-disk.mjs', 'drivers/k8s/cluster/disk-probe.ts'), 'yaac-disk.mjs')
