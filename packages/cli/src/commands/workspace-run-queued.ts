import { api } from '#commands/api'
import { confirmDefault } from '@yaac/shared/confirm'
import { formatCommits } from '@yaac/shared/steps'

/**
 * `yaac workspace run-queued <id>`: run a queued workspace now, as the
 * webapp's Run now does. One awaiting a person's approval
 * (docs/workflows.md "Approvals") is shown first: the workflow it would
 * run, the run secrets it names and each repo's commit. Approving sends
 * that workflow's id and those commits, so the server runs exactly what was
 * shown or refuses. Asks first unless `--yes`; with no terminal to ask on, it fails
 * naming `--yes`.
 */
export async function workspaceRunQueued(idOrPrefix: string, opts: { yes?: boolean } = {}): Promise<void> {
  const token = idOrPrefix.trim().toLowerCase()
  const matches = (await api.workspace.queue.list.$get({ query: {} })).filter((e) => e.id.startsWith(token))
  if (matches.length === 0) throw new Error(`No queued workspace "${idOrPrefix}".`)
  if (matches.length > 1) throw new Error(`"${idOrPrefix}" matches more than one queued workspace; use a longer prefix.`)
  const [entry] = matches
  const request = entry.awaitingApproval
  if (request !== undefined) {
    console.log(`Queued workspace ${entry.id} awaits your approval to run with run secrets:`)
    console.log(`  workflow     ${request.workflowId}${request.writtenByAgent === true ? ' (written by an agent)' : ''}`)
    console.log(`  run secrets  ${request.secrets.join(', ') || 'none'}`)
    console.log(`  commits      ${request.commits.length > 0 ? formatCommits(request.commits, 12) : 'none (no repos)'}`)
    for (const line of JSON.stringify(request.steps, null, 2).split('\n')) console.log(`  ${line}`)
    if (!opts.yes && !process.stdin.isTTY) {
      console.error('No terminal to confirm on; pass --yes to approve what is shown above.')
      process.exitCode = 1
      return
    }
    if (!opts.yes && !await confirmDefault('Approve exactly this, and run it?')) {
      console.log('Not approved; it keeps waiting.')
      return
    }
  }
  const { workspaceId } = await api.workspace.queue.run.$post({ json: {
    id: entry.id,
    ...(request !== undefined ? { approve: { workflowId: request.workflowId, commits: request.commits } } : {}),
  } })
  // An unapproved run can still find it needs a person's approval as it
  // launches, and wait for one instead.
  console.log(request !== undefined
    ? `Queued workspace ${entry.id} is starting as workspace ${workspaceId}.`
    : `Queued workspace ${entry.id} is launching as workspace ${workspaceId}, unless it needs a person's approval, `
      + 'when it waits for one instead (`yaac workspace list` shows it).')
}
