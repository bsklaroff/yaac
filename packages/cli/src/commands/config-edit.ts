import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { api, resolveProjectId } from '#commands/api'
import { editFile } from '#commands/edit-file'

/**
 * Edit server-side config files: fetch the content from the server, edit a
 * scratch copy in $EDITOR on this machine, and PUT the result back. Works
 * the same for a local or remote server. A failed save keeps the scratch
 * file so edits are not lost.
 */

interface ScratchEdit {
  text: string
  tmpDir: string
  tmpPath: string
}

/** Returns null (after printing) when the editor made no change. */
async function editInScratch(filename: string, initial: string): Promise<ScratchEdit | null> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-edit-'))
  const tmpPath = path.join(tmpDir, filename)
  await fs.writeFile(tmpPath, initial)
  await editFile(tmpPath)
  const text = await fs.readFile(tmpPath, 'utf8')
  if (text === initial) {
    await fs.rm(tmpDir, { recursive: true, force: true })
    console.log('No changes.')
    return null
  }
  return { text, tmpDir, tmpPath }
}

async function discardScratch(edit: ScratchEdit): Promise<void> {
  await fs.rm(edit.tmpDir, { recursive: true, force: true })
}

function failKeepingEdits(err: unknown, edit: ScratchEdit): void {
  console.error(err instanceof Error ? err.message : String(err))
  console.error(`Your edits are kept at ${edit.tmpPath}`)
  process.exitCode = 1
}

/**
 * `yaac config edit <project>`: edit the project's yaac-config.json. Opens
 * the raw file, so malformed content can be repaired; the save is validated
 * by the server. Emptying the buffer clears the config.
 */
export async function configEditProject(project: string): Promise<void> {
  const projectId = await resolveProjectId(project)
  const { content } = await api.project[':projectId'].config.raw.$get({ param: { projectId } })
  const edit = await editInScratch('yaac-config.json', content)
  if (!edit) return

  if (edit.text.trim() === '') {
    await api.project[':projectId'].config.$delete({ param: { projectId } })
    await discardScratch(edit)
    console.log('Cleared project config — defaults apply.')
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(edit.text)
  } catch (err) {
    failKeepingEdits(
      new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`),
      edit,
    )
    return
  }
  try {
    await api.project[':projectId'].config.$put({ param: { projectId }, json: { config: parsed } })
  } catch (err) {
    failKeepingEdits(err, edit)
    return
  }
  await discardScratch(edit)
  console.log('Saved project config.')
}

/** `yaac config edit-dockerfile <project>`: the project's Dockerfile.yaac. */
export async function configEditDockerfile(project: string): Promise<void> {
  const projectId = await resolveProjectId(project)
  const { content } = await api.project[':projectId'].dockerfile.$get({ param: { projectId } })
  const edit = await editInScratch('Dockerfile.yaac', content)
  if (!edit) return

  try {
    await api.project[':projectId'].dockerfile.$put({
      param: { projectId },
      json: { content: edit.text },
    })
  } catch (err) {
    failKeepingEdits(err, edit)
    return
  }
  await discardScratch(edit)
  console.log(edit.text.trim() === ''
    ? 'Cleared Dockerfile.yaac — the image reverts to the base stack on the next workspace create.'
    : 'Saved Dockerfile.yaac — it applies to the next workspace created.')
}

/** `yaac config edit-user-dockerfile`: the caller's own Dockerfile.user. */
export async function configEditUserDockerfile(): Promise<void> {
  const { content } = await api.config['user-dockerfile'].$get()
  const edit = await editInScratch('Dockerfile.user', content)
  if (!edit) return

  try {
    await api.config['user-dockerfile'].$put({ json: { content: edit.text } })
  } catch (err) {
    failKeepingEdits(err, edit)
    return
  }
  await discardScratch(edit)
  console.log(edit.text.trim() === ''
    ? 'Cleared the user Dockerfile.'
    : 'Saved the user Dockerfile.')
}
