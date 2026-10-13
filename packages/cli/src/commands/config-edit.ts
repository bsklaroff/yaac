import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { api, resolveProjectId } from '#commands/api'
import { editFile } from '#commands/edit-file'

/**
 * Edit a server-side config file: edit a scratch copy of `content` in
 * $EDITOR on this machine, then hand the result to `save`, which writes it
 * back and returns what to print. Works the same for a local or remote
 * server. A failed save keeps the scratch file so edits are not lost.
 */
async function editRemote(
  filename: string,
  content: string,
  save: (text: string) => Promise<string>,
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-edit-'))
  const tmpPath = path.join(tmpDir, filename)
  await fs.writeFile(tmpPath, content)
  await editFile(tmpPath)
  const text = await fs.readFile(tmpPath, 'utf8')
  if (text === content) {
    await fs.rm(tmpDir, { recursive: true, force: true })
    console.log('No changes.')
    return
  }
  let saved: string
  try {
    saved = await save(text)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    console.error(`Your edits are kept at ${tmpPath}`)
    process.exitCode = 1
    return
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
  console.log(saved)
}

/**
 * `yaac config edit <project>`: edit the project's yaac-config.json. Opens
 * the raw file, so malformed content can be repaired; the save is validated
 * by the server. Emptying the buffer clears the config.
 */
export async function configEditProject(project: string): Promise<void> {
  const projectId = await resolveProjectId(project)
  const { content } = await api.project[':projectId'].config.raw.$get({ param: { projectId } })
  await editRemote('yaac-config.json', content, async (text) => {
    if (text.trim() === '') {
      await api.project[':projectId'].config.$delete({ param: { projectId } })
      return 'Cleared project config — defaults apply.'
    }
    let config: unknown
    try {
      config = JSON.parse(text)
    } catch (err) {
      throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
    await api.project[':projectId'].config.$put({ param: { projectId }, json: { config } })
    return 'Saved project config.'
  })
}

/** `yaac config edit-dockerfile <project>`: the project's Dockerfile.yaac. */
export async function configEditDockerfile(project: string): Promise<void> {
  const projectId = await resolveProjectId(project)
  const { content } = await api.project[':projectId'].dockerfile.$get({ param: { projectId } })
  await editRemote('Dockerfile.yaac', content, async (text) => {
    await api.project[':projectId'].dockerfile.$put({ param: { projectId }, json: { content: text } })
    return text.trim() === ''
      ? 'Cleared Dockerfile.yaac — the image reverts to the base stack on the next workspace create.'
      : 'Saved Dockerfile.yaac — it applies to the next workspace created.'
  })
}

/** `yaac config edit-user-dockerfile`: the caller's own Dockerfile.user. */
export async function configEditUserDockerfile(): Promise<void> {
  const { content } = await api.config['user-dockerfile'].$get()
  await editRemote('Dockerfile.user', content, async (text) => {
    await api.config['user-dockerfile'].$put({ json: { content: text } })
    return text.trim() === '' ? 'Cleared the user Dockerfile.' : 'Saved the user Dockerfile.'
  })
}
