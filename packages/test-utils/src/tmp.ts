import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ambientDataDir } from '@yaac/shared/paths'

let hermeticScratch = false

/**
 * Declare that this run never mounts its scratch into a pod, so the base
 * below can be the OS tmpdir. Called by unit-setup, which the `unit:*`
 * projects load and nothing else — "unit tests must not touch podman or the
 * cluster" (AGENTS.md) is exactly the property that makes node visibility
 * irrelevant to them.
 *
 * Takes a boolean rather than being one-way so this module's own tests can
 * drive both branches; the only production caller passes `true`.
 */
export function setHermeticScratch(on: boolean): void {
  hermeticScratch = on
}

/**
 * Base directory for test scratch dirs (test data dirs, mock-git repo
 * stores, CLI scratch).
 *
 * Two audiences, split by the question the storage tiers in
 * packages/shared/src/paths.ts already ask — who has to see these bytes?
 *
 *  - Hermetic runs (the `unit:*` projects, via {@link setHermeticScratch})
 *    never create a pod, so nothing outside the test process has to see
 *    this. The OS tmpdir is both correct and better: local, fast, reaped by
 *    the OS. Unit assertions are timestamp-sensitive too, so they must NOT
 *    land on a virtiofs/network data dir — the same reason unit-setup
 *    strips YAAC_DATA_DIR.
 *
 *  - Everything else (api, e2e) hostPath-mounts paths under its data dir
 *    into pods, so the base must resolve to the SAME absolute path on the
 *    host and on the pod's node. `os.tmpdir()` carries no such guarantee:
 *    on a kind host `/tmp` is the node container's own tmpfs, and a pod
 *    mounting a host `/tmp/...` path hangs Pending. The data dir does carry
 *    it — it is the SHARED tier by definition, and `yaac cluster check`'s
 *    end-to-end probe mounts it into a pod on every setup precisely to
 *    prove the node can see it. Hanging scratch off it means any cluster
 *    that passes `cluster check` runs e2e with no TMPDIR and no
 *    kind-specific setup.
 *
 * {@link ambientDataDir} rather than `getDataDir()` because this is called
 * BEFORE any data dir exists — each test's data dir is created *under* this
 * base, so the override would be circular. Inside a nested yaac session it
 * resolves to `$YAAC_DATA_DIR` (node-shared virtiofs, removed with the
 * session dir on cleanup), the only path that works there: the pod's
 * `/tmp` and `$HOME` are overlay filesystems the node cannot see.
 */
export function testTmpBase(): string {
  if (hermeticScratch) return os.tmpdir()
  return path.join(ambientDataDir(), 'e2e-tmp')
}

/** mkdtemp under the test temp base (see {@link testTmpBase}). */
export async function e2eMkdtemp(prefix: string): Promise<string> {
  const base = testTmpBase()
  await fs.mkdir(base, { recursive: true })
  return fs.mkdtemp(path.join(base, prefix))
}
