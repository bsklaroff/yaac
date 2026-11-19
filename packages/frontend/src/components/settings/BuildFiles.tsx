import { useRef, useState, type FormEvent, type JSX } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileEditor } from '#components/settings/FileEditor'
import { languageForPath } from '#lib/highlight'
import { DeleteIcon, RenameIcon } from '#lib/icons'
import type { BuildFilesApi } from '#lib/buildFilesApi'
import { YButton, YFileInput, YInput } from '#ui'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

/**
 * Manages one build dir's support files (the Dockerfile's build context):
 * list, delete, edit, create, and upload files or folders. `filesApi` picks
 * the scope (one project or the global user layer). `title` prefixes the
 * expanded editor's title. `readOnly` (a teammate's project) only lists and
 * shows them.
 */
export function BuildFiles({ filesApi, title, readOnly = false }: {
  filesApi: BuildFilesApi
  title: string
  readOnly?: boolean
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
    return <p className="text-md text-subtle">Loading…</p>
  }

  return (
    <div className="flex flex-col gap-2 text-md">
      {files !== undefined && files.length > 0 && (
        <div className="divide-y divide-line">
          {files.map((f) => (
            <div
              key={f.path}
              className={clsx('flex min-h-8 items-center gap-2', f.path === selected ? 'bg-selected' : !f.binary && 'hover:bg-hover')}
            >
              <YButton
                variant="bare"
                disabled={f.binary}
                onClick={() => setSelected(f.path === selected ? null : f.path)}
                title={f.binary ? 'Binary files can be replaced by re-uploading' : `Open ${f.path}`}
                className={clsx(
                  'min-h-8 min-w-0 flex-1 self-stretch truncate text-left font-mono disabled:opacity-100',
                  f.binary ? 'text-subtle' : f.path === selected ? 'text-text' : 'text-muted',
                )}
              >
                {f.path}
              </YButton>
              <span className="shrink-0 font-mono text-xs text-subtle">
                {f.binary && 'binary · '}{formatSize(f.size)}
              </span>
              {!readOnly && <><YButton
                variant="ghost"
                size="sm"
                icon={RenameIcon}
                onClick={() => renameFile(f.path)}
                title={`Rename ${f.path}`}
                aria-label={`Rename ${f.path}`}
              />
              <YButton
                variant="ghost"
                size="sm"
                icon={DeleteIcon}
                onClick={() => removeFile(f.path)}
                title={`Delete ${f.path}`}
                aria-label={`Delete ${f.path}`}
              /></>}
            </div>
          ))}
        </div>
      )}
      {files !== undefined && files.length === 0 && (
        <p className="text-subtle">No files yet.</p>
      )}

      {!readOnly && <><div className="flex flex-wrap items-center gap-2">
        <YButton size="sm" onClick={() => fileInputRef.current?.click()} disabled={op.isPending}>
          Upload files
        </YButton>
        <YButton size="sm" onClick={() => folderInputRef.current?.click()} disabled={op.isPending}>
          Upload folder
        </YButton>
        {progress && <span className="text-sm text-subtle">{progress}</span>}
        <YFileInput
          ref={fileInputRef}
          multiple
          aria-label="Upload files"
          onChange={(e) => onPickFiles(e.currentTarget, (f) => f.name)}
        />
        <YFileInput
          ref={folderInputRef}
          directory
          aria-label="Upload folder"
          onChange={(e) => onPickFiles(e.currentTarget, (f) => f.webkitRelativePath || f.name)}
        />
      </div>
      {/* A web page cannot make the OS picker show dotfiles, so tell the
          user how. Folder uploads include hidden files anyway. */}
      <p className="text-xs leading-relaxed text-subtle">
        Dotfiles are hidden in the file picker — press{' '}
        <kbd className="font-mono">⌘⇧.</kbd> (macOS) or <kbd className="font-mono">Ctrl+H</kbd>{' '}
        (Linux) there to show them, or type the name. Folder uploads include hidden files
        automatically.
      </p>

      <form onSubmit={createFile} className="flex gap-2">
        <YInput
          name="path"
          placeholder="new file path, e.g. nvim/init.lua"
          autoComplete="off"
          className="flex-1 font-mono"
        />
        <YButton type="submit">New file</YButton>
      </form></>}

      {error && <p className="whitespace-pre-wrap text-danger">{error.message}</p>}

      {selected && (
        <FileEditor
          key={`${title}:${selected}`}
          title={`${title} · ${selected}`}
          language={languageForPath(selected)}
          queryKey={[...filesApi.key, selected]}
          load={() => load(selected)}
          {...(readOnly ? {} : {
            save: async (text: string) => {
              await filesApi.saveText(selected, text)
              void queryClient.invalidateQueries({ queryKey: filesApi.key, exact: true }) // sizes changed
            },
          })}
        />
      )}
    </div>
  )
}
