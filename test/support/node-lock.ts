import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { claimPidFile } from '@yaac/test-utils/pid-file'
import { testTmpBase } from '@yaac/test-utils/tmp'

/**
 * A readers-writer lock over the kind node, across the e2e workers. Every
 * e2e file holds it shared for its whole run (`cluster-setup.ts`); a case
 * that disturbs the whole node, such as restarting its CNI, takes it
 * exclusive, so no other file starts or runs pods meanwhile. Its state is
 * files under the test scratch base: a marker per shared holder and one
 * file naming the exclusive holder, each carrying its process's pid, so a
 * holder that died (a killed run skips its teardown) counts as gone.
 */

const POLL_MS = 250

function lockDir(): string {
  return path.join(testTmpBase(), 'node-lock')
}

function writerFile(): string {
  return path.join(lockDir(), 'exclusive')
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Whether another live process holds the lock exclusive. */
async function heldExclusive(): Promise<boolean> {
  const pid = Number.parseInt(await fs.readFile(writerFile(), 'utf8').catch(() => ''), 10)
  return !Number.isNaN(pid) && pid !== process.pid && alive(pid)
}

/**
 * Hold the lock shared, waiting out an exclusive holder. The marker is
 * written before the exclusive file is checked again, so a holder that
 * claimed it meanwhile sees the marker and waits, or this one backs off.
 * Resolves to the release.
 */
export async function acquireNodeShared(): Promise<() => Promise<void>> {
  const readers = path.join(lockDir(), 'shared')
  await fs.mkdir(readers, { recursive: true })
  const marker = path.join(readers, `${String(process.pid)}-${crypto.randomBytes(4).toString('hex')}`)
  for (;;) {
    while (await heldExclusive()) await sleep(POLL_MS)
    await fs.writeFile(marker, '')
    if (!await heldExclusive()) break
    await fs.rm(marker, { force: true })
  }
  return async () => { await fs.rm(marker, { force: true }) }
}

/**
 * Hold the lock exclusive: claim it, then wait until no other live process
 * holds it shared. This process's own shared hold does not count. Resolves
 * to the release.
 */
export async function acquireNodeExclusive(): Promise<() => Promise<void>> {
  await fs.mkdir(lockDir(), { recursive: true })
  while (!await claimPidFile(writerFile())) await sleep(POLL_MS)
  const readers = path.join(lockDir(), 'shared')
  for (;;) {
    const others = (await fs.readdir(readers).catch((): string[] => []))
      .map((name) => Number.parseInt(name, 10))
      .filter((pid) => pid !== process.pid && alive(pid))
    if (others.length === 0) break
    await sleep(POLL_MS)
  }
  return async () => { await fs.rm(writerFile(), { force: true }) }
}
