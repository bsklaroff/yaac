import { api, resolveProjectId } from '#commands/api'
import { printTable } from '#commands/table'
import { confirmDefault } from '@yaac/shared/confirm'

/**
 * `yaac volume …`: a project's volumes (docs/workspace-volumes.md), named
 * storage one running workspace at a time mounts. A workspace takes one
 * with `yaac workspace create --volume`, and keeps it across restarts.
 */

export async function volumeCreate(project: string, name: string, opts: { size?: string } = {}): Promise<void> {
  await api.volume.create.$post({ json: { project: await resolveProjectId(project), name, size: opts.size } })
  console.log(`Created volume "${name}". Mount it with: yaac workspace create ${project} --volume ${name}`)
}

export async function volumeList(project: string): Promise<void> {
  const volumes = await api.volume.list.$get({ query: { project: await resolveProjectId(project) } })
  if (volumes.length === 0) {
    console.log(`No volumes in ${project}. Create one with: yaac volume create ${project} <name>`)
    return
  }
  const who = (w: { workspaceId: string; title?: string }): string =>
    `${w.workspaceId.slice(0, 8)}${w.title !== undefined ? ` (${w.title})` : ''}`
  printTable(
    [{ header: 'NAME' }, { header: 'SIZE' }, { header: 'ATTACHED TO' }, { header: 'STOPPED WORKSPACES' }],
    volumes.map((v) => [
      v.name,
      v.size,
      v.holder !== undefined ? who(v.holder) : '-',
      v.stoppedWorkspaces.map(who).join(', '),
    ]),
  )
}

export async function volumeResize(project: string, name: string, size: string): Promise<void> {
  await api.volume.resize.$post({ json: { project: await resolveProjectId(project), name, size } })
  console.log(`Volume "${name}" is growing to ${size}.`)
}

/** Asks first, as `workspace delete` does; `--yes` skips it, and a run
 *  with no terminal must pass it. */
export async function volumeDelete(project: string, name: string, opts: { yes?: boolean } = {}): Promise<void> {
  if (!opts.yes && !process.stdin.isTTY) {
    console.error('No terminal to confirm on; pass --yes to delete without asking.')
    process.exitCode = 1
    return
  }
  if (!opts.yes && !await confirmDefault(`This permanently deletes volume "${name}" and every file in it. Continue?`)) {
    console.log('Aborted — nothing was deleted.')
    return
  }
  await api.volume.delete.$post({ json: { project: await resolveProjectId(project), name } })
  console.log(`Deleted volume "${name}" and its data.`)
}
