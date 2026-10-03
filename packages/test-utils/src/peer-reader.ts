import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

let built: Promise<string> | undefined

/**
 * Build the server's git reader (`peer-reader`) to plain JavaScript, for a
 * test to hand `setPeerReaderEntry`, so it runs in the same permission
 * sandbox as the built CLI. Source run through tsx cannot be sandboxed: its
 * loader needs a worker thread, and a worker can leave the permission model.
 * Built once per test process; the output is self-contained.
 */
export function buildPeerReader(): Promise<string> {
  built ??= (async () => {
    const outfile = path.join(os.tmpdir(), `yaac-git-peer-reader-${String(process.pid)}.mjs`)
    await build({
      entryPoints: [fileURLToPath(new URL('../../server/src/domain/git/peer-reader.ts', import.meta.url))],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'error',
      // isomorphic-git's CommonJS dependencies call `require`.
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    })
    return outfile
  })()
  return built
}
