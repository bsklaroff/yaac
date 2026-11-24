import { useRef, useState, type FormEvent, type JSX } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery } from '@tanstack/react-query'
import { FileEditor } from '#components/settings/FileEditor'
import { languageForPath } from '#lib/highlight'
import { DeleteIcon, RenameIcon } from '#lib/icons'
import { IMAGE_KEY } from '#lib/images'
import { YButton, YFileInput, YInput } from '#ui'

/** A support file in the edited set: as stored (its hash and size), or as
 *  text typed here, uploaded when the image is saved. */
export type EditedFile = { sha256: string; size: number } | { text: string }
export type EditedFiles = Record<string, EditedFile>

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

const sizeOf = (f: EditedFile): number => ('text' in f ? new TextEncoder().encode(f.text).length : f.size)

/** Why `path` cannot join `others`: it is taken, or a file and a folder
 *  would share a name. */
function clash(path: string, others: string[]): string | null {
  const hit = others.find((p) => p === path || p.startsWith(`${path}/`) || path.startsWith(`${p}/`))
  return hit === undefined ? null : hit === path ? `${path} already exists` : `${path} clashes with ${hit}`
}

/**
 * An image's support files (the Dockerfile's build context), held by the
 * caller until it saves: list, rename, delete, edit, create, and upload
 * files or folders. An upload sends the bytes at once (`upload`) and keeps
 * only the hash it returns. `readText` loads a stored file for the editor.
 * Without `onChange` the list is read-only; without `upload`, nothing can
 * be added yet.
 */
export function BuildFiles({ files, onChange, upload, readText, title }: {
  files: EditedFiles
  onChange?: (files: EditedFiles) => void
  upload?: (data: ArrayBuffer) => Promise<{ sha256: string; size: number }>
  readText: (path: string, file: { sha256: string }) => Promise<string>
  /** Prefixes the expanded editor's title. */
  title: string
}): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const paths = Object.keys(files).sort()
  const open = selected !== null ? files[selected] : undefined
  const stored = open !== undefined && !('text' in open) ? open : undefined
  const loaded = useQuery({
    queryKey: [IMAGE_KEY, 'file', selected, stored?.sha256],
    queryFn: () => readText(selected ?? '', stored ?? { sha256: '' }),
    enabled: stored !== undefined,
  })

  const uploading = useMutation({
    mutationFn: async (items: Array<{ rel: string; file: File }>) => {
      const added: EditedFiles = {}
      for (let i = 0; i < items.length; i++) {
        setProgress(`Uploading ${i + 1}/${items.length}…`)
        added[items[i].rel] = await upload!(await items[i].file.arrayBuffer())
      }
      return added
    },
    onSuccess: (added) => onChange?.({ ...files, ...added }),
    onSettled: () => setProgress(null),
  })

  if (!onChange && paths.length === 0) return <p className="text-md text-subtle">No files.</p>

  const onPickFiles = (input: HTMLInputElement, relOf: (f: File) => string): void => {
    const items = Array.from(input.files ?? []).map((file) => ({ rel: relOf(file), file }))
    input.value = '' // so re-picking the same selection fires change again
    if (items.length > 0) uploading.mutate(items)
  }

  const createFile = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const formElement = event.currentTarget
    const raw = new FormData(formElement).get('path')
    const rel = (typeof raw === 'string' ? raw : '').trim()
    if (!rel || !onChange) return
    const why = clash(rel, paths)
    setRefused(why)
    if (why !== null) return
    onChange({ ...files, [rel]: { text: '' } })
    formElement.reset()
    setSelected(rel)
  }

  const renameFile = (from: string): void => {
    const to = window.prompt(`Rename ${from} to:`, from)?.trim()
    if (!to || to === from || !onChange) return
    const why = clash(to, paths.filter((p) => p !== from))
    setRefused(why)
    if (why !== null) return
    onChange(Object.fromEntries(Object.entries(files).map(([p, f]) => [p === from ? to : p, f])))
    if (selected === from) setSelected(to)
  }

  const removeFile = (path: string): void => {
    if (!onChange) return
    onChange(Object.fromEntries(Object.entries(files).filter(([p]) => p !== path)))
    if (selected === path) setSelected(null)
  }

  return (
    <div className="flex flex-col gap-2 text-md">
      {paths.length > 0 && (
        <div className="divide-y divide-line">
          {paths.map((path) => (
            <div key={path} className={clsx('flex min-h-8 items-center gap-2', path === selected ? 'bg-selected' : 'hover:bg-hover')}>
              <YButton
                variant="bare"
                onClick={() => setSelected(path === selected ? null : path)}
                title={`Open ${path}`}
                className={clsx('min-h-8 min-w-0 flex-1 self-stretch truncate text-left font-mono',
                  path === selected ? 'text-text' : 'text-muted')}
              >
                {path}
              </YButton>
              <span className="shrink-0 font-mono text-xs text-subtle">
                {'text' in files[path] && 'edited · '}{formatSize(sizeOf(files[path]))}
              </span>
              {onChange && <>
                <YButton
                  variant="ghost"
                  size="sm"
                  icon={RenameIcon}
                  onClick={() => renameFile(path)}
                  title={`Rename ${path}`}
                  aria-label={`Rename ${path}`}
                />
                <YButton
                  variant="ghost"
                  size="sm"
                  icon={DeleteIcon}
                  onClick={() => removeFile(path)}
                  title={`Delete ${path}`}
                  aria-label={`Delete ${path}`}
                />
              </>}
            </div>
          ))}
        </div>
      )}
      {onChange && paths.length === 0 && <p className="text-subtle">No files yet.</p>}

      {onChange && !upload && <p className="text-sm text-subtle">Save the Dockerfile once to add files.</p>}
      {onChange && upload && <>
        <div className="flex flex-wrap items-center gap-2">
          <YButton size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading.isPending}>
            Upload files
          </YButton>
          <YButton size="sm" onClick={() => folderInputRef.current?.click()} disabled={uploading.isPending}>
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
        </form>
      </>}

      {refused && <p className="text-danger">{refused}</p>}
      {uploading.error && <p className="whitespace-pre-wrap text-danger">{uploading.error.message}</p>}

      {selected !== null && open !== undefined && (
        'text' in open || loaded.data !== undefined ? (
          <FileEditor
            key={selected}
            title={`${title} · ${selected}`}
            language={languageForPath(selected)}
            value={'text' in open ? open.text : loaded.data ?? ''}
            {...(onChange ? { onChange: (text: string) => onChange({ ...files, [selected]: { text } }) } : {})}
          />
        ) : (
          <p className={loaded.error ? 'text-danger' : 'text-subtle'}>{loaded.error?.message ?? 'Loading…'}</p>
        )
      )}
    </div>
  )
}
