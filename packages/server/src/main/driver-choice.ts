import fs from 'node:fs/promises'
import { serverLocalPath } from '@yaac/shared/paths'
import { env } from '@yaac/shared/env'
import { liveWorkspaceCount } from '#drivers/containerless'
import { serverLog } from '#log'
import type { DriverKind } from '@yaac/shared/types'

/**
 * Which substrate an install runs, remembered across restarts.
 *
 * The driver is chosen from the environment, which is right — it has to be
 * settled before the database is open. What is not right is that a shell
 * without `YAAC_DRIVER` therefore selects the DEFAULT, so `yaac server
 * restart` from an ordinary terminal silently moves a containerless install
 * onto k8s. That is not a cosmetic surprise: the k8s driver then sees rows
 * with no pods, reaps them, and its teardown removes the very state dirs
 * this driver's markers live in — leaving the tmux servers and their agents
 * running as the user, holding their checkouts, invisible to yaac and
 * unreapable forever.
 *
 * So the choice is written down when a server starts, and a start with no
 * explicit choice adopts what is written. An explicit `--driver` still
 * wins: switching a data dir between substrates is a thing you may
 * deliberately do, and it is logged.
 *
 * With one refusal, and only one — switching AWAY from a substrate that
 * still has live workspaces. It is not a policy about mixing; it is that
 * this particular switch is irreversible. The incoming driver cannot see
 * the outgoing one's workspaces, so it reaps their rows as podless, and its
 * teardown removes the state dirs the outgoing driver's markers live in.
 * After that nothing can find them: a containerless worktree's agents keep
 * running as the user, holding their checkouts, invisible to every future
 * server. Stopping them first costs one command and keeps the switch a
 * decision rather than a trap.
 */

/**
 * Refuse a switch that would strand something still running.
 *
 * `assertDriverSwitchSafe` is the same check run by the PARENT of a
 * detached start, before it spawns anything: a child that throws this dies
 * before its log is wired, so the operator would otherwise wait out the
 * 30s ready poll and be told the server "did not become ready" — which
 * says nothing about the worktrees it was protecting.
 *
 * Only asks the containerless side, and only because only it can be
 * stranded: a pod outlives a server too, but it stays visible to `kubectl`
 * and reapable by the next k8s server, whereas a tmux server whose marker
 * has been deleted is findable by nothing. An outgoing driver that cannot
 * answer lets the switch through — being unable to reach a substrate is a
 * legitimate reason to be switching away from it.
 */
export async function assertDriverSwitchSafe(): Promise<void> {
  const explicit = env.driverExplicit
  const recorded = await recordedDriver()
  if (explicit === undefined || recorded === undefined || explicit === recorded) return
  await refuseIfOutgoingHasLiveWorkspaces(recorded, explicit)
}

async function refuseIfOutgoingHasLiveWorkspaces(
  outgoing: DriverKind,
  incoming: DriverKind,
): Promise<void> {
  if (outgoing !== 'containerless') return
  const live = await liveWorkspaceCount().catch(() => 0)
  if (live === 0) return
  throw new Error(
    `Refusing to switch this install from ${outgoing} to ${incoming}: `
    + `${String(live)} worktree(s) are still running on this host, and a `
    + `${incoming} server cannot see or stop them — it would reap their rows `
    + 'and delete the state that makes them findable, leaving their agents '
    + 'running and unmanageable.\n'
    + '    Stop them first (`yaac worktree stop <id>`, or `yaac worktree list` '
    + 'to see them), then start again with --driver.',
  )
}

/** SERVER-LOCAL, beside the lock: the choice belongs to this install, not to
 *  a project, and it is not something a worktree's state should carry. */
function driverFilePath(): string {
  return serverLocalPath('driver')
}

/** What this install last ran, or undefined if it has never started. */
export async function recordedDriver(): Promise<DriverKind | undefined> {
  try {
    const raw = (await fs.readFile(driverFilePath(), 'utf8')).trim()
    return raw === 'k8s' || raw === 'containerless' ? raw : undefined
  } catch {
    return undefined
  }
}

/**
 * The driver this process should run, and the record of it for the next
 * start.
 *
 * `YAAC_DRIVER` set (by the operator, or by `--driver` publishing it) is an
 * explicit choice and wins. Unset means "whatever this install was already
 * running", which is what makes a bare `yaac server restart` keep serving
 * the worktrees it already has.
 */
export async function resolveDriverKind(): Promise<DriverKind> {
  const explicit = env.driverExplicit
  const recorded = await recordedDriver()
  const chosen = explicit ?? recorded ?? 'k8s'

  if (explicit !== undefined && recorded !== undefined && explicit !== recorded) {
    await refuseIfOutgoingHasLiveWorkspaces(recorded, explicit)
    serverLog(`[server] driver: switching this install from ${recorded} to ${explicit}`)
  } else if (explicit === undefined && recorded !== undefined) {
    serverLog(`[server] driver: ${recorded} (recorded by a previous start)`)
  }

  await fs.writeFile(driverFilePath(), `${chosen}\n`).catch((err: unknown) => {
    // Not fatal, but worth saying: the next restart falls back to the
    // default, which is the failure this file exists to prevent.
    serverLog(`[server] driver: could not record the choice: ${String(err)}`)
  })
  return chosen
}
