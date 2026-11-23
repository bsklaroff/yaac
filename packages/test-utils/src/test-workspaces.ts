import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { testTmpBase } from './tmp'

const execFileAsync = promisify(execFile)

/**
 * The containerless workspaces test servers leave on the host. Stopping a
 * containerless server leaves its workspaces up by design (tmux outlives
 * it), so a test that created one and did not stop it, or failed before it
 * could, leaves a tmux server and its panes running.
 *
 * A test's workspace is recognised by the directory its tmux server was
 * started in (`new-session -c`, a checkout under the test's data dir), which
 * no other process on the host has: not another rig's, and not the
 * developer's own install.
 */

/** In a test's scratch dir: the pid of the process that made it. */
const OWNER_FILE = 'owner-pid'

/** Record this process as the one using `scratchDir`, so a sweep by another
 *  run on the same rig leaves its workspaces alone while it lives. */
export async function claimTestScratch(scratchDir: string): Promise<void> {
  await fs.writeFile(path.join(scratchDir, OWNER_FILE), String(process.pid))
}

/** A process's cgroup v2 path, or '' where it has none (macOS, cgroup v1). */
async function cgroupOf(pid: string): Promise<string> {
  const text = await fs.readFile(`/proc/${pid}/cgroup`, 'utf8').catch(() => '')
  return /^0::(\/\S*)$/m.exec(text)?.[1] ?? ''
}

/**
 * Stop every workspace started in a directory under `dir`, and resolve how
 * many there were. Where the launch put a workspace in a systemd slice
 * (docs/containerless-driver.md), stopping the slice also ends what its
 * panes started and detached from.
 *
 * A slice is stopped only when the tmux server sits in a `systemd-run` scope
 * directly in a workspace slice, which is where a launch puts it, and only
 * when the caller is outside that slice. A tmux server a test starts itself
 * inherits the caller's cgroup, and inside a containerless workspace that is
 * the workspace's own slice: stopping it would end the run doing the stop.
 */
export async function stopTestWorkspaces(
  dir: string,
  only: (cwd: string) => Promise<boolean> = () => Promise.resolve(true),
): Promise<number> {
  const { stdout } = await execFileAsync('ps', ['-ww', '-eo', 'pid=,args='], { maxBuffer: 64 * 1024 * 1024 })
    .catch(() => ({ stdout: '' }))
  const self = await cgroupOf('self')
  let stopped = 0
  for (const line of stdout.split('\n')) {
    const [, pid, sock, cwd] = /^\s*(\d+) (?:\S*\/)?tmux -S (\S+) .* new-session .* -c (\S+)/.exec(line) ?? []
    if (cwd === undefined || !`${cwd}/`.startsWith(`${dir}/`) || !await only(cwd)) continue
    const scope = await cgroupOf(pid)
    const slice = path.dirname(scope)
    const launched = /\/run-[^/]+\.scope$/.test(scope)
      && /yaac-[0-9a-f]+_[0-9a-f]+\.slice$/.test(path.basename(slice))
      && !`${self}/`.startsWith(`${slice}/`)
    await execFileAsync('tmux', ['-S', sock, 'kill-server']).catch(() => { /* already gone */ })
    if (launched) {
      await execFileAsync('systemctl', ['--user', 'stop', path.basename(slice)], { timeout: 15_000 })
        .catch(() => { /* no user session */ })
    }
    stopped += 1
  }
  return stopped
}

/**
 * Stop the workspaces earlier runs on this rig left behind: those under a
 * scratch dir of `testTmpBase()` that is gone, or whose owner is no longer
 * running, which is what an interrupted run leaves. A scratch dir with no
 * owner recorded is left alone: a run from a checkout that records none may
 * be using it.
 */
export async function stopAbandonedTestWorkspaces(): Promise<number> {
  const base = testTmpBase()
  return stopTestWorkspaces(base, async (cwd) => {
    const scratchDir = path.join(base, cwd.slice(base.length + 1).split('/')[0])
    const owner = await fs.readFile(path.join(scratchDir, OWNER_FILE), 'utf8').catch(() => null)
    if (owner === null) return !await fs.stat(scratchDir).then(() => true, () => false)
    try {
      process.kill(Number(owner), 0)
      return false
    } catch {
      return true
    }
  })
}
