import { useRef, useState, type FormEvent, type JSX } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileEditor } from '#components/settings/FileEditor'
import { languageForPath } from '#lib/highlight'
import { DeleteIcon, RenameIcon } from '#lib/icons'
import type { BuildFilesApi } from '#lib/buildFilesApi'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

/**
 * Manages one build dir's support files (the Dockerfile's build context):
 * list, delete, edit, create, and upload files or folders. `filesApi` picks
 * the scope (one project or the global user layer). `title` prefixes the
 * expanded editor's title.
 */
export function BuildFiles({ filesApi, title }: {
  filesApi: BuildFilesApi
  title: string
}): JSX.Element {
  const queryClient = useQueryClient()
  const { data: files, error: loadError } = useQuery({
    queryKey: filesApi.key,
    queryFn: () => filesApi.list(),
    staleTime: 0,
  })
  const [selected, setSelected] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  // Every change re-lists, since sizes and paths move.
  const op = useMutation({
    mutationFn: (run: () => Promise<void>) => run(),
    onSettled: () => {
      setProgress(null)
      return queryClient.invalidateQueries({ queryKey: filesApi.key, exact: true })
    },
  })
  const error = op.error ?? loadError

  const onPickFiles = (input: HTMLInputElement, relOf: (f: File) => string): void => {
    const items = Array.from(input.files ?? []).map((file) => ({ rel: relOf(file), file }))
    input.value = '' // so re-picking the same selection fires change again
    if (items.length === 0) return
    op.mutate(async () => {
      for (let i = 0; i < items.length; i++) {
        setProgress(`Uploading ${i + 1}/${items.length}…`)
        await filesApi.upload(items[i].rel, await items[i].file.arrayBuffer())
      }
    })
  }

  const createFile = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const formElement = event.currentTarget
    const raw = new FormData(formElement).get('path')
    const rel = (typeof raw === 'string' ? raw : '').trim()
    if (!rel) return
    op.mutate(async () => {
      await filesApi.saveText(rel, '')
      formElement.reset()
      setSelected(rel)
    })
  }

  const renameFile = (from: string): void => {
    const to = window.prompt(`Rename ${from} to:`, from)?.trim()
    if (!to || to === from) return
    op.mutate(async () => {
      await filesApi.rename(from, to)
      // Follow the open editor to the new path (file or a parent folder move).
      if (selected === from) setSelected(to)
      else if (selected?.startsWith(`${from}/`)) setSelected(`${to}${selected.slice(from.length)}`)
    })
  }

  const removeFile = (path: string): void => {
    if (!window.confirm(`Delete ${path}?`)) return
    op.mutate(async () => {
      await filesApi.remove(path)
      if (selected === path || selected?.startsWith(`${path}/`)) setSelected(null)
    })
  }

  const load = async (path: string): Promise<string> => {
    const file = await filesApi.read(path)
    if (file.content === null) {
      throw new Error(file.binary ? `${path} is a binary file` : `${path} is too large to edit inline`)
    }
    return file.content
  }

  if (files === undefined && !loadError) {
    return <p className="text-xs text-text-faint">Loading…</p>
  }

  return (
    <div className="flex flex-col gap-2 text-xs">
      {files !== undefined && files.length > 0 && (
        <div className="overflow-hidden rounded-md border border-hairline-soft">
          {files.map((f) => (
            <div
              key={f.path}
              className={clsx(
                'flex items-center gap-2 px-2.5 py-1.5 transition',
                f.path === selected ? 'bg-surface-3' : 'hover:bg-surface-2/60',
              )}
            >
              <button
                type="button"
                disabled={f.binary}
                onClick={() => setSelected(f.path === selected ? null : f.path)}
                title={f.binary ? 'Binary files can be replaced by re-uploading' : `Edit ${f.path}`}
                className={clsx(
                  'min-w-0 flex-1 truncate text-left font-mono',
                  f.binary ? 'cursor-default text-text-faint' : 'text-text-dim hover:text-text',
                )}
              >
                {f.path}
              </button>
              <span className="shrink-0 font-mono text-[10px] text-text-faint">
                {f.binary && 'binary · '}{formatSize(f.size)}
              </span>
              <button
                type="button"
                onClick={() => renameFile(f.path)}
                title={`Rename ${f.path}`}
                aria-label={`Rename ${f.path}`}
                className="shrink-0 rounded p-0.5 text-text-faint transition hover:text-text"
              >
                <RenameIcon size={12} />
              </button>
              <button
                type="button"
                onClick={() => removeFile(f.path)}
                title={`Delete ${f.path}`}
                aria-label={`Delete ${f.path}`}
                className="shrink-0 rounded p-0.5 text-text-faint transition hover:text-red-400"
              >
                <DeleteIcon size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {files !== undefined && files.length === 0 && (
        <p className="text-text-faint">No files yet.</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={op.isPending}
          className="rounded-md bg-surface-3 px-2.5 py-1 text-[11px] font-medium text-text transition
            hover:bg-border-strong disabled:opacity-50"
        >
          Upload files
        </button>
        <button
          type="button"
          onClick={() => folderInputRef.current?.click()}
          disabled={op.isPending}
          className="rounded-md bg-surface-3 px-2.5 py-1 text-[11px] font-medium text-text transition
            hover:bg-border-strong disabled:opacity-50"
        >
          Upload folder
        </button>
        {progress && <span className="text-[11px] text-text-faint">{progress}</span>}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          aria-label="Upload files"
          onChange={(e) => onPickFiles(e.currentTarget, (f) => f.name)}
        />
        <input
          ref={folderInputRef}
          type="file"
          hidden
          aria-label="Upload folder"
          // Non-standard but universal: makes the picker select a directory,
          // with each file carrying its folder-relative path.
          {...{ webkitdirectory: '' }}
          onChange={(e) => onPickFiles(e.currentTarget, (f) => f.webkitRelativePath || f.name)}
        />
      </div>
      {/* A web page cannot make the OS picker show dotfiles, so tell the
          user how. Folder uploads include hidden files anyway. */}
      <p className="text-[10px] leading-relaxed text-text-faint">
        Dotfiles are hidden in the file picker — press{' '}
        <kbd className="font-mono">⌘⇧.</kbd> (macOS) or <kbd className="font-mono">Ctrl+H</kbd>{' '}
        (Linux) there to show them, or type the name. Folder uploads include hidden files
        automatically.
      </p>

      <form onSubmit={createFile} className="flex gap-2">
        <input
          name="path"
          placeholder="new file path, e.g. nvim/init.lua"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono
            text-xs text-text outline-none focus:border-border-strong"
        />
        <button
          type="submit"
          className="shrink-0 rounded-md bg-surface-3 px-2.5 text-[11px] font-medium text-text transition
            hover:bg-border-strong"
        >
          New file
        </button>
      </form>

      {error && <p className="whitespace-pre-wrap text-red-400">{error.message}</p>}

      {selected && (
        <FileEditor
          key={`${title}:${selected}`}
          title={`${title} · ${selected}`}
          language={languageForPath(selected)}
          queryKey={[...filesApi.key, selected]}
          load={() => load(selected)}
          save={async (text) => {
            await filesApi.saveText(selected, text)
            void queryClient.invalidateQueries({ queryKey: filesApi.key, exact: true }) // sizes changed
          }}
        />
      )}
    </div>
  )
}
