import { useCallback, useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import clsx from 'clsx'
import { FileEditor } from '#components/settings/FileEditor'
import type { CodeLanguage } from '#components/ui/CodeEditor'
import { DeleteIcon } from '#lib/icons'
import type { BuildFileEntry, BuildFilesApi } from '#lib/buildFilesApi'

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function languageFor(path: string): CodeLanguage {
  if (path.endsWith('.json')) return 'json'
  const base = path.split('/').pop() ?? path
  if (base.startsWith('Dockerfile') || base.endsWith('.dockerfile')) return 'dockerfile'
  return 'text'
}

/**
 * Manager for one build dir's support files (the Dockerfile's build
 * context): a file list with per-row delete, click-to-edit via FileEditor,
 * a new-file input, and file/folder upload buttons. Scope comes from the
 * injected `filesApi` (per-project or global user), so both settings
 * sections render this same component. `title` prefixes the expanded
 * editor's overlay title.
 */
export function BuildFiles({ filesApi, title }: {
  filesApi: BuildFilesApi
  title: string
}): JSX.Element {
  const [files, setFiles] = useState<BuildFileEntry[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setFiles(await filesApi.list())
    } catch (e) {
      setError(errMessage(e))
    }
  }, [filesApi])

  useEffect(() => {
    setFiles(null)
    setSelected(null)
    setError(null)
    void refresh()
  }, [refresh])

  const uploadAll = async (items: { rel: string; file: File }[]): Promise<void> => {
    if (items.length === 0) return
    setError(null)
    try {
      for (let i = 0; i < items.length; i++) {
        setBusy(`Uploading ${i + 1}/${items.length}…`)
        await filesApi.upload(items[i].rel, await items[i].file.arrayBuffer())
      }
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setBusy(null)
      await refresh()
    }
  }

  const onPickFiles = (input: HTMLInputElement, relOf: (f: File) => string): void => {
    const items = Array.from(input.files ?? []).map((file) => ({ rel: relOf(file), file }))
    input.value = '' // so re-picking the same selection fires change again
    void uploadAll(items)
  }

  const createFile = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const formElement = event.currentTarget
    const raw = new FormData(formElement).get('path')
    const rel = (typeof raw === 'string' ? raw : '').trim()
    if (!rel) return
    setError(null)
    try {
      await filesApi.saveText(rel, '')
      formElement.reset()
      await refresh()
      setSelected(rel)
    } catch (e) {
      setError(errMessage(e))
    }
  }

  const removeFile = async (path: string): Promise<void> => {
    if (!window.confirm(`Delete ${path}?`)) return
    setError(null)
    try {
      await filesApi.remove(path)
      if (selected === path || selected?.startsWith(`${path}/`)) setSelected(null)
      await refresh()
    } catch (e) {
      setError(errMessage(e))
    }
  }

  // Stable per selection — FileEditor reloads when `load` changes identity.
  const load = useCallback(async (): Promise<string> => {
    if (!selected) return ''
    const file = await filesApi.read(selected)
    if (file.content === null) {
      throw new Error(file.binary ? `${selected} is a binary file` : `${selected} is too large to edit inline`)
    }
    return file.content
  }, [filesApi, selected])

  const save = useCallback(async (text: string): Promise<void> => {
    if (!selected) return
    await filesApi.saveText(selected, text)
    void refresh() // sizes changed
  }, [filesApi, selected, refresh])

  if (files === null && error === null) {
    return <p className="text-xs text-text-faint">Loading…</p>
  }

  return (
    <div className="flex flex-col gap-2 text-xs">
      {files !== null && files.length > 0 && (
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
                onClick={() => void removeFile(f.path)}
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
      {files !== null && files.length === 0 && (
        <p className="text-text-faint">No files yet.</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy !== null}
          className="rounded-md bg-surface-3 px-2.5 py-1 text-[11px] font-medium text-text transition
            hover:bg-border-strong disabled:opacity-50"
        >
          Upload files
        </button>
        <button
          type="button"
          onClick={() => folderInputRef.current?.click()}
          disabled={busy !== null}
          className="rounded-md bg-surface-3 px-2.5 py-1 text-[11px] font-medium text-text transition
            hover:bg-border-strong disabled:opacity-50"
        >
          Upload folder
        </button>
        {busy && <span className="text-[11px] text-text-faint">{busy}</span>}
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
      {/* The OS picker can't be forced to display dotfiles from a web page,
          so point at the escape hatches. Folder uploads traverse the picked
          dir programmatically, so its hidden files come through regardless. */}
      <p className="text-[10px] leading-relaxed text-text-faint">
        Dotfiles are hidden in the file picker — press{' '}
        <kbd className="font-mono">⌘⇧.</kbd> (macOS) or <kbd className="font-mono">Ctrl+H</kbd>{' '}
        (Linux) there to show them, or type the name. Folder uploads include hidden files
        automatically.
      </p>

      <form onSubmit={(e) => void createFile(e)} className="flex gap-2">
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

      {error && <p className="whitespace-pre-wrap text-red-400">{error}</p>}

      {selected && (
        <FileEditor
          key={`${title}:${selected}`}
          title={`${title} · ${selected}`}
          language={languageFor(selected)}
          load={load}
          save={save}
        />
      )}
    </div>
  )
}
