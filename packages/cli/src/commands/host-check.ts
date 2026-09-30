import { formatCheckResult } from '@yaac/shared/checks'
import { runHostCheck } from '@yaac/server/drivers/containerless/check'

/**
 * `yaac host check`: verify this machine can run containerless workspaces
 * and print a fix for anything missing. Exits 1 on hard failures.
 *
 * With no image, every tool a workspace needs must already be on the host;
 * otherwise the workspace's tmux window just opens and exits.
 */
export async function hostCheck(): Promise<void> {
  const results = await runHostCheck()
  for (const r of results) {
    console.log(formatCheckResult(r))
  }
  if (results.some((r) => r.status === 'fail')) {
    console.error('\nThis host cannot run yaac workspaces yet. Fix the failures above and re-run.')
    process.exitCode = 1
  } else {
    console.log('\nThis host can run yaac workspaces.')
  }
}
