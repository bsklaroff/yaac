import { api } from '#commands/api'
import { printTable } from '#commands/table'
import { stripAnsi } from '@yaac/shared/ansi'
import type { WorkspaceLogLife } from '@yaac/shared/types'

/**
 * `yaac workspace logs <id> [window]`: a workspace's terminal logs
 * (docs/workspace-steps.md "Logs"), kept for every life until it is
 * deleted, so a stopped workspace's read the same. With no window it lists
 * one life's files; with one (a step's name, or any logged window's) it
 * prints that window's log, the rotated-out part first.
 */
export async function workspaceLogs(
  workspace: string,
  window: string | undefined,
  opts: { life?: string; raw?: boolean } = {},
): Promise<void> {
  const lives = await api.workspace[':id'].logs.$get({ param: { id: workspace } })
  const life = pickLife(lives, opts.life)
  if (life === undefined) {
    console.log(lives.length === 0 ? `Workspace ${workspace} has no logs yet.` : `No life "${opts.life ?? ''}"; it has ${lives.length}, newest first.`)
    if (lives.length > 0) process.exitCode = 1
    return
  }
  if (window === undefined) {
    console.log(`Life ${life.life} (${lives.indexOf(life) + 1} of ${lives.length}, newest first):`)
    printTable([{ header: 'FILE' }, { header: 'BYTES' }], life.files.map((f) => [f.name, String(f.size)]))
    return
  }
  const files = [`${window}.log.1`, `${window}.log`].filter((f) => life.files.some((l) => l.name === f))
  if (files.length === 0) throw new Error(`No log for "${window}" in life ${life.life}; run without it to list the logs there.`)
  for (const file of files) {
    for (let offset = 0; ;) {
      const res = await api.workspace[':id'].logs[':life'][':file'].$get({
        param: { id: workspace, life: life.life, file },
        query: { offset: String(offset) },
      })
      const data = Buffer.from(await res.arrayBuffer())
      process.stdout.write(opts.raw === true ? data : stripAnsi(data.toString('utf8')))
      const next = Number(res.headers.get('x-log-next'))
      if (data.length === 0 || !(next < Number(res.headers.get('x-log-size')))) break
      offset = next
    }
  }
}

/** The life `--life` names: a 1-based position, newest first, or a life
 *  dir's name; the newest without one. */
function pickLife(lives: WorkspaceLogLife[], wanted: string | undefined): WorkspaceLogLife | undefined {
  if (wanted === undefined) return lives[0]
  if (/^\d+$/.test(wanted)) return lives[Number(wanted) - 1]
  return lives.find((l) => l.life === wanted)
}
