import { execFile, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claimTestScratch, stopAbandonedTestWorkspaces, stopTestWorkspaces } from '#test-workspaces'
import { setHermeticScratch, testTmpBase } from '#tmp'

const run = promisify(execFile)
const HAS_TMUX = ['/usr/bin/tmux', '/opt/homebrew/bin/tmux', '/usr/local/bin/tmux'].some((p) => existsSync(p))

/** A rig of its own: the data dir `testTmpBase()` hangs off, and a short
 *  dir for sockets, whose paths are length-limited. */
let rig: string
let socks: string
let started: string[]

/** Start a tmux server the way a containerless launch does, in `cwd`, and
 *  return its socket. */
async function workspaceIn(cwd: string): Promise<string> {
  await fs.mkdir(cwd, { recursive: true })
  const sock = path.join(socks, `${String(started.length)}.sock`)
  started.push(sock)
  await run('tmux', ['-S', sock, '-f', '/dev/null', 'new-session', '-d', '-s', 'yaac', '-c', cwd, 'sleep 600'])
  return sock
}

const running = (sock: string): Promise<boolean> =>
  run('tmux', ['-S', sock, 'has-session', '-t', 'yaac']).then(() => true, () => false)

beforeEach(async () => {
  rig = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-test-ws-'))
  socks = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ws-'))
  started = []
  // As an e2e run has it: scratch under the rig's data dir, not the OS
  // tmpdir every other test on this host shares.
  setHermeticScratch(false)
  vi.stubEnv('YAAC_DATA_DIR', rig)
})

afterEach(async () => {
  for (const sock of started) await run('tmux', ['-S', sock, 'kill-server']).catch(() => {})
  vi.unstubAllEnvs()
  setHermeticScratch(true)
  await fs.rm(rig, { recursive: true, force: true })
  await fs.rm(socks, { recursive: true, force: true })
})

describe.skipIf(!HAS_TMUX)('stopTestWorkspaces', () => {
  it('stops the workspaces started under a dir, and no other', async () => {
    const mine = path.join(testTmpBase(), 'yaac-e2ecli-mine')
    await fs.mkdir(mine, { recursive: true })
    await claimTestScratch(mine)
    const [first, second, sibling, elsewhere] = await Promise.all([
      workspaceIn(path.join(mine, 'data', 'workspaces', 'a')),
      workspaceIn(path.join(mine, 'data', 'workspaces', 'b', 'web')),
      // A dir whose name only starts the same.
      workspaceIn(path.join(testTmpBase(), 'yaac-e2ecli-mine-too', 'data', 'workspaces', 'c')),
      workspaceIn(path.join(rig, 'not-scratch')),
    ])

    // A file's own cleanup: its owner is this live process.
    expect(await stopTestWorkspaces(mine)).toBe(2)

    expect(await Promise.all([first, second, sibling, elsewhere].map(running))).toEqual([false, false, true, true])
  })
})

describe.skipIf(!HAS_TMUX)('stopAbandonedTestWorkspaces', () => {
  it('stops what a finished or interrupted run left, and leaves a run that may be live alone', async () => {
    const scratch = (name: string): string => path.join(testTmpBase(), name)
    const checkout = (name: string): string => path.join(scratch(name), 'data', 'workspaces', 'w')
    const gone = spawnSync('true').pid

    const live = await workspaceIn(checkout('live'))
    await claimTestScratch(scratch('live'))
    // Its owner exited without cleaning up.
    const interrupted = await workspaceIn(checkout('interrupted'))
    await fs.writeFile(path.join(scratch('interrupted'), 'owner-pid'), String(gone))
    // Its scratch dir was removed while its workspace still ran.
    const removed = await workspaceIn(checkout('removed'))
    await fs.rm(scratch('removed'), { recursive: true })
    // Made by a checkout that records no owner, which may still be running.
    const unowned = await workspaceIn(checkout('unowned'))
    // Another rig's, or the developer's own.
    const elsewhere = await workspaceIn(path.join(rig, 'global', 'projects', 'p', 'workspaces', 'w'))

    expect(await stopAbandonedTestWorkspaces()).toBe(2)

    expect(await Promise.all([live, interrupted, removed, unowned, elsewhere].map(running)))
      .toEqual([true, false, false, true, true])
  })
})
