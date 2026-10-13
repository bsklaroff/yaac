import { ServerError } from '@yaac/shared/errors'
import { api } from '#lib/api'
import { createWorkspaceFolder } from '#lib/files'

/**
 * Files and folders a user drops on, or picks in, the explorer
 * (docs/file-editor.md, "Uploads"). Each file is one request streaming its
 * bytes, so nothing is held in memory and a failure costs only that file.
 */

/** A file to write, or (neither `file` nor `error`) a dropped folder
 *  holding nothing, to create, or a dropped entry the browser could not
 *  read. `path` is relative to the folder the upload lands in. */
export interface Upload {
  path: string
  file?: File
  error?: string
}

/** How many files upload at once. */
const PARALLEL = 4

/** The files an `<input type="file">` picked; a folder picker names each
 *  by its path under the picked folder. */
export function pickedUploads(files: FileList): Upload[] {
  return [...files].map((file) => ({ path: file.webkitRelativePath || file.name, file }))
}

/**
 * What a drop carries, folders walked recursively. The entries are taken
 * before the first await, since the browser empties `items` once the drop
 * event returns. A browser without entries gets the top-level files only.
 * An entry that cannot be read (a broken link, a folder without
 * permission) is reported in place, so the rest still upload.
 */
export async function droppedUploads(data: DataTransfer): Promise<Upload[]> {
  const items = [...data.items].filter((i) => i.kind === 'file')
  const entries = items.map((i) => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null))
  if (entries.some((e) => e === null)) return pickedUploads(data.files)
  const out: Upload[] = []
  const walk = async (entry: FileSystemEntry, path: string): Promise<void> => {
    try {
      if (isFile(entry)) {
        out.push({ path, file: await new Promise<File>((resolve, reject) => entry.file(resolve, reject)) })
        return
      }
      if (!isDirectory(entry)) return
      const reader = entry.createReader()
      const children: FileSystemEntry[] = []
      // A folder is read in batches, ending with an empty one.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
        if (batch.length === 0) break
        children.push(...batch)
      }
      if (children.length === 0) out.push({ path })
      for (const child of children) await walk(child, `${path}/${child.name}`)
    } catch (err) {
      out.push({ path, error: `couldn’t read it (${err instanceof Error ? err.message : String(err)})` })
    }
  }
  for (const entry of entries as FileSystemEntry[]) await walk(entry, entry.name)
  return out
}

const isFile = (e: FileSystemEntry): e is FileSystemFileEntry => e.isFile
const isDirectory = (e: FileSystemEntry): e is FileSystemDirectoryEntry => e.isDirectory

/** How a batch of uploads went: the ones refused because something was
 *  already there, and why each other failure happened, by full path. */
export interface UploadResult {
  taken: Upload[]
  failed: string[]
}

/**
 * Upload into `parent` ('' for the root), a few at a time, calling
 * `onProgress` with how many are done. Without `replace` a file already
 * there is left alone and reported as `taken`; an empty folder already
 * there is no failure.
 */
export async function sendUploads(
  workspaceId: string,
  parent: string,
  uploads: Upload[],
  replace: boolean,
  onProgress: (done: number) => void,
): Promise<UploadResult> {
  const result: UploadResult = { taken: [], failed: [] }
  let next = 0
  let done = 0
  const send = async (to: string, { file, error }: Upload): Promise<void> => {
    if (error !== undefined) throw new Error(error)
    if (file) {
      await api.workspace[':id'].upload.$put(
        { param: { id: workspaceId }, query: replace ? { path: to, replace: '1' } : { path: to } },
        { init: { body: file, headers: { 'Content-Type': 'application/octet-stream' } } },
      )
    } else {
      await createWorkspaceFolder(workspaceId, to).catch((err: unknown) => {
        if (!(err instanceof ServerError && err.code === 'CONFLICT')) throw err
      })
    }
  }
  const worker = async (): Promise<void> => {
    while (next < uploads.length) {
      const upload = uploads[next++]
      const to = parent ? `${parent}/${upload.path}` : upload.path
      try {
        await send(to, upload)
      } catch (err) {
        if (err instanceof ServerError && err.code === 'CONFLICT') result.taken.push(upload)
        else result.failed.push(`${to}: ${err instanceof Error ? err.message : String(err)}`)
      }
      onProgress(++done)
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker))
  return result
}
