import fs from 'node:fs/promises'
import { buffer } from 'node:stream/consumers'
import { api, resolveProject } from '#commands/api'

/*
 * `yaac config icon <project>`: say whether a project has an icon, the
 * picture its chip shows in the webapp's sidebar in place of its initial,
 * or replace it from an image file (`-` for stdin), or remove it. The server takes the file
 * as it is (PNG, JPEG, GIF or WebP); unlike the webapp, this draws no SVG.
 */
export async function configIcon(project: string, opts: { file?: string; none?: boolean }): Promise<void> {
  const { id: projectId, name, iconHash } = await resolveProject(project)
  const icon = api.project[':projectId'].icon
  if (opts.file !== undefined && opts.none === true) throw new Error('Pass --file or --none, not both.')
  if (opts.none === true) {
    await icon.$delete({ param: { projectId } })
    console.log(`Removed ${name}'s icon: its chip shows its initial again.`)
    return
  }
  if (opts.file === undefined) {
    console.log(iconHash === undefined ? `${name} has no icon; its chip shows its initial.` : `${name} has an icon.`)
    return
  }
  const file = opts.file
  const bytes = await (file === '-' ? buffer(process.stdin) : fs.readFile(file)).catch((err: unknown) => {
    throw new Error(`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`)
  })
  await icon.$put({ param: { projectId } }, { init: { body: bytes } })
  console.log(`Saved ${name}'s icon.`)
}
