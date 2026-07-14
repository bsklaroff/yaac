import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { api } from '#commands/api'
import { editFile } from '#commands/edit-file'

/**
 * Config editing over RPC: fetch the current content from the server,
 * edit a scratch copy in $EDITOR on this machine, and PUT the result
 * back — the same flow against a local or remote server, since the
 * files live on the server host either way. Failed saves keep the
 * scratch file so edits are never lost.
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
 * `yaac config edit <project>` — the project's yaac-config.json. Reads
 * the raw file (malformed content opens verbatim so it can be repaired);
 * saving goes through the server's validated config write, so the stored
 * file is always parseable. Emptying the buffer clears the config.
 */
export async function configEditProject(slug: string): Promise<void> {
  const { content } = await api.project[':slug'].config.raw.$get({ param: { slug } })
  const edit = await editInScratch('yaac-config.json', content)
  if (!edit) return

  if (edit.text.trim() === '') {
    await api.project[':slug'].config.$delete({ param: { slug } })
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
    await api.project[':slug'].config.$put({ param: { slug }, json: { config: parsed } })
  } catch (err) {
    failKeepingEdits(err, edit)
    return
  }
  await discardScratch(edit)
  console.log('Saved project config.')
}

/** `yaac config edit-dockerfile <project>` — the project's Dockerfile.yaac. */
export async function configEditDockerfile(slug: string): Promise<void> {
  const { content } = await api.project[':slug'].dockerfile.$get({ param: { slug } })
  const edit = await editInScratch('Dockerfile.yaac', content)
  if (!edit) return

  try {
    await api.project[':slug'].dockerfile.$put({
      param: { slug },
      json: { content: edit.text },
    })
  } catch (err) {
    failKeepingEdits(err, edit)
    return
  }
  await discardScratch(edit)
  console.log(edit.text.trim() === ''
    ? 'Cleared Dockerfile.yaac — the image reverts to the base stack on next rebuild.'
    : `Saved Dockerfile.yaac — apply it with: yaac project rebuild ${slug}`)
}

/** `yaac config edit-user-dockerfile` — the global Dockerfile.user. */
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
