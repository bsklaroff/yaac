import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Base directory for e2e scratch dirs (test data dirs, mock-git repo
 * stores). These get hostPath-mounted into pods, so the path must exist
 * identically on the pod's node.
 *
 * On a normal host `os.tmpdir()` works (subject to the kind extraMount
 * note in CLAUDE.md). Inside a nested yaac session it does NOT: `/tmp`
 * (and `$HOME`) are the inner pod's overlay filesystem, invisible to the
 * node, so a `/tmp/...` hostPath can never be satisfied and pods hang
 * Pending. The nested data dir (`$YAAC_DATA_DIR`) is a node-shared
 * virtiofs mount at the same absolute path on host and node, so scratch
 * dirs must live under it there. Detect that case and relocate, so e2e
 * runs in-session without anyone having to set `TMPDIR` by hand.
 */
export function e2eTmpBase(): string {
  if (process.env.YAAC_NESTED === '1' && process.env.YAAC_DATA_DIR) {
    return path.join(process.env.YAAC_DATA_DIR, 'e2e-tmp')
  }
  return os.tmpdir()
}

/** mkdtemp under the node-visible e2e temp base (see {@link e2eTmpBase}). */
export async function e2eMkdtemp(prefix: string): Promise<string> {
  const base = e2eTmpBase()
  await fs.mkdir(base, { recursive: true })
  return fs.mkdtemp(path.join(base, prefix))
}
