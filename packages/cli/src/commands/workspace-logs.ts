import { api } from '#commands/api'
import { printTable } from '#commands/table'
import { stripAnsi } from '@yaac/shared/ansi'
import { isAgentWindow } from '@yaac/shared/steps'
import type { WorkspaceLogLife } from '@yaac/shared/types'

/**
 * `yaac workspace logs <id> [window]`: a workspace's terminal logs
 * (docs/workspace-steps.md "Logs"), kept for every life until it is
 * deleted, so a stopped workspace's read the same. With no window it lists
 * one life's files; with one (a step's full name `<workflow>.<step>`, a
 * bare one while only one workflow of the life has it, or any logged
 * window's) it prints that window's log, the rotated-out part first. An
 * agent session's window is left out of the listing (`isAgentWindow`) but
 * still read by name, its current file only.
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
  const named = stepWindow(life, window)
  const listed = [`${named}.log.1`, `${named}.log`].filter((f) => life.files.some((l) => l.name === f))
  const files = listed.length > 0 ? listed : isAgentWindow(window) ? [`${window}.log`] : []
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

/** The window a name means in a life: itself if it logged, else the one
 *  step of that bare name, refused when several workflows have one. */
function stepWindow(life: WorkspaceLogLife, window: string): string {
  const windows = life.files.filter((f) => f.name.endsWith('.log')).map((f) => f.name.slice(0, -'.log'.length))
  if (windows.includes(window) || window.includes('.')) return window
  const steps = windows.filter((w) => w.endsWith(`.${window}`) && w.indexOf('.') === w.length - window.length - 1)
  if (steps.length > 1) throw new Error(`"${window}" is a step of several workflows: ${steps.join(', ')}; give its full name.`)
  return steps[0] ?? window
}
