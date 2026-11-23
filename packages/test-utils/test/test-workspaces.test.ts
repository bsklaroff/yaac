import { execFile, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
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
const HAS_SYSTEMD_RUN = HAS_TMUX
  && spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true']).status === 0

/** A rig of its own: the data dir `testTmpBase()` hangs off, and a short
 *  dir for sockets, whose paths are length-limited. */
let rig: string
let socks: string
let started: string[]
/** Slices this file created, which it stops itself once the PATH stub that
 *  hides `systemctl` is lifted. */
let madeSlices: string[]
/** Where the stub `systemctl` on PATH records each call, so no test here
 *  stops a real slice, least of all the one this run is in. */
let systemctlLog: string

/** Start a tmux server the way a containerless launch does, in `cwd`, and
 *  return its socket. With `slice`, tmux starts in a `systemd-run` scope of
 *  that slice, as a launch with a user session puts it. */
async function workspaceIn(cwd: string, slice?: string): Promise<string> {
  await fs.mkdir(cwd, { recursive: true })
  const sock = path.join(socks, `${String(started.length)}.sock`)
  started.push(sock)
  const tmux = ['tmux', '-S', sock, '-f', '/dev/null', 'new-session', '-d', '-s', 'yaac', '-c', cwd, 'sleep 600']
  const argv = slice === undefined ? tmux : ['systemd-run', '--user', '--scope', '--quiet', '--collect', `--slice=${slice}`, ...tmux]
  await run(argv[0], argv.slice(1))
  return sock
}

const running = (sock: string): Promise<boolean> =>
  run('tmux', ['-S', sock, 'has-session', '-t', 'yaac']).then(() => true, () => false)

beforeEach(async () => {
  rig = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-test-ws-'))
  socks = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ws-'))
  started = []
  madeSlices = []
  const bin = path.join(rig, 'bin')
  systemctlLog = path.join(rig, 'systemctl.log')
  await fs.mkdir(bin)
  await fs.writeFile(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> '${systemctlLog}'\n`, { mode: 0o755 })
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`)
  // As an e2e run has it: scratch under the rig's data dir, not the OS
  // tmpdir every other test on this host shares.
  setHermeticScratch(false)
  vi.stubEnv('YAAC_DATA_DIR', rig)
})

afterEach(async () => {
  for (const sock of started) await run('tmux', ['-S', sock, 'kill-server']).catch(() => {})
  vi.unstubAllEnvs()
  for (const slice of madeSlices) await run('systemctl', ['--user', 'stop', slice]).catch(() => {})
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

  it.skipIf(!HAS_SYSTEMD_RUN)('stops the slice a launch put a workspace in, and never the caller\'s', async () => {
    const hex = (n: number): string => randomBytes(n).toString('hex')
    const launched = `yaac-${hex(4)}_${hex(16)}.slice`
    madeSlices.push(launched)
    // Inside a containerless workspace, that workspace's own slice. The
    // case runs only there, so a dev host gets no stray slice units.
    const callerSlice = path.basename(path.dirname(
      /^0::(\S*)$/m.exec(await fs.readFile('/proc/self/cgroup', 'utf8'))?.[1] ?? ''))
    const mine = path.join(testTmpBase(), 'yaac-e2ecli-mine')
    const servers = await Promise.all([
      workspaceIn(path.join(mine, 'launched'), launched),
      // Started by the test process, so in its cgroup.
      workspaceIn(path.join(mine, 'inherited')),
      .../yaac-[0-9a-f]+_[0-9a-f]+\.slice$/.test(callerSlice)
        ? [workspaceIn(path.join(mine, 'in-caller'), callerSlice)]
        : [],
    ])

    expect(await stopTestWorkspaces(mine)).toBe(servers.length)

    expect(await Promise.all(servers.map(running))).toEqual(servers.map(() => false))
    expect(await fs.readFile(systemctlLog, 'utf8')).toBe(`--user stop ${launched}\n`)
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
