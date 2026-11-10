import fs from 'node:fs/promises'
import { buffer } from 'node:stream/consumers'
import { api, resolveProject } from '#commands/api'

/*
 * `yaac config icon <project>`: say whether a project has an icon, the
 * picture its chip shows in the webapp's sidebar in place of its initial,
 * save it to a file (`-` for stdout), replace it from an image file (`-` for
 * stdin), or remove it. The server takes the file as it is (PNG, JPEG, GIF
 * or WebP); unlike the webapp, this draws no SVG.
 */
export async function configIcon(project: string, opts: { out?: string; file?: string; none?: boolean }): Promise<void> {
  const { id: projectId, name, iconHash } = await resolveProject(project)
  const icon = api.project[':projectId'].icon
  if ([opts.out, opts.file, opts.none].filter((o) => o !== undefined).length > 1) {
    throw new Error('Pass only one of --out, --file and --none.')
  }
  if (opts.out !== undefined) {
    if (iconHash === undefined) throw new Error(`${name} has no icon; its chip shows its initial.`)
    const res = await icon.$get({ param: { projectId } })
    const bytes = Buffer.from(await res.arrayBuffer())
    if (opts.out === '-') {
      process.stdout.write(bytes)
      return
    }
    await fs.writeFile(opts.out, bytes)
    console.log(`Saved ${name}'s icon (${res.headers.get('content-type') ?? 'image'}, ${bytes.length} bytes) to ${opts.out}.`)
    return
  }
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
