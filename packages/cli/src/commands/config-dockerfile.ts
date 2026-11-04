import fs from 'node:fs/promises'
import { text } from 'node:stream/consumers'
import { api, resolveProject } from '#commands/api'

/*
 * `yaac config dockerfile <project>` and `yaac config user-dockerfile`: print
 * a Dockerfile the server keeps, or replace it from a file (`-` for stdin, so
 * a heredoc works) or with none. Stored on the server, so this works against
 * a remote one too.
 */

interface DockerfileOpts { file?: string; none?: boolean }

/** The replacement the options ask for, or undefined to print. */
async function replacement(opts: DockerfileOpts): Promise<string | undefined> {
  if (opts.file !== undefined && opts.none === true) throw new Error('Pass --file or --none, not both.')
  if (opts.none === true) return ''
  if (opts.file === undefined) return undefined
  try {
    return opts.file === '-' ? await text(process.stdin) : await fs.readFile(opts.file, 'utf8')
  } catch (err) {
    throw new Error(`Cannot read ${opts.file}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Print it as stored, so `> file` round-trips; an empty one says so on
 *  stderr instead. */
function print(content: string, empty: string): void {
  if (content === '') console.error(empty)
  else process.stdout.write(content)
}

export async function configDockerfile(project: string, opts: DockerfileOpts): Promise<void> {
  const { id: projectId, name } = await resolveProject(project)
  const content = await replacement(opts)
  if (content === undefined) {
    print((await api.project[':projectId'].dockerfile.$get({ param: { projectId } })).content,
      `${name} has no Dockerfile.yaac; its workspaces run the default image.`)
    return
  }
  await api.project[':projectId'].dockerfile.$put({ param: { projectId }, json: { content } })
  console.log(content.trim() === ''
    ? `Cleared ${name}'s Dockerfile.yaac: the next workspace created runs the default image.`
    : `Saved ${name}'s Dockerfile.yaac: it applies to the next workspace created.`)
}

export async function configUserDockerfile(opts: DockerfileOpts): Promise<void> {
  const content = await replacement(opts)
  if (content === undefined) {
    print((await api.config['user-dockerfile'].$get()).content, 'You have no Dockerfile.user.')
    return
  }
  await api.config['user-dockerfile'].$put({ json: { content } })
  console.log(content.trim() === ''
    ? 'Cleared your Dockerfile.user.'
    : 'Saved your Dockerfile.user: it applies to the next workspace created in each of your projects.')
}
