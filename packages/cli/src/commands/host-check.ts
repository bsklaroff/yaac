import { formatCheckResult } from '@yaac/shared/checks'
import { runHostCheck } from '@yaac/server/drivers/containerless/check'

/**
 * `yaac host check` — verify this machine can run worktrees without
 * containers, and print actionable fixes for anything missing. Exits 1 on
 * hard failures.
 *
 * The containerless parallel of `yaac cluster check`: with no image to
 * install anything into, every tool a worktree needs has to already be on
 * this host, and without this the failure is a tmux window that opens and
 * exits with nobody watching.
 */
export async function hostCheck(): Promise<void> {
  const results = await runHostCheck()
  for (const r of results) {
    console.log(formatCheckResult(r))
  }
  if (results.some((r) => r.status === 'fail')) {
    console.error('\nThis host cannot run yaac worktrees yet. Fix the failures above and re-run.')
    process.exitCode = 1
  } else {
    console.log('\nThis host can run yaac worktrees.')
  }
}
