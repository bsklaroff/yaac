import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Base directory for e2e scratch dirs (test data dirs, mock-git repo
 * stores). These get hostPath-mounted into pods, so the path must exist
 * identically on the pod's node.
 *
 * That makes the whole base SHARED-tier by contract (the tier legend lives
 * in packages/shared/src/paths.ts): a test data dir created under it holds
 * all three tiers of a yaac install, and the shared one is the binding
 * constraint. It is picked here rather than from `sharedRoot()` because
 * the base is chosen BEFORE any data dir exists, from the ambient
 * environment — the test process's own data dir is a temp dir under it.
 *
 * On a host that's `os.tmpdir()` (OS-cleaned, `TMPDIR`-respecting —
 * subject to the kind extraMount note in CLAUDE.md). Inside a nested
 * yaac session it is NOT (`nestedYaacDataDir`, itself SHARED-tier in the
 * outer install): `/tmp` (and `$HOME`) are the inner pod's
 * overlay filesystem, invisible to the node, so a `/tmp/...` hostPath
 * can never be satisfied and pods hang Pending. The nested data dir
 * (`$YAAC_DATA_DIR`) is a node-shared virtiofs mount at the same
 * absolute path on host and node, so scratch lives under it there (and
 * is removed with the session dir on cleanup). Keyed on `YAAC_NESTED`,
 * not on `YAAC_DATA_DIR` alone: a host may legitimately run a custom
 * data dir and still wants its scratch in the OS tmpdir.
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
