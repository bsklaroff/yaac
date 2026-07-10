import { useState, type FormEvent, type JSX } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { AddIcon } from '@/frontend/lib/icons'
import { addProject } from '@/frontend/lib/projectApi'
import { useUiStore } from '@/frontend/store'

/**
 * Rail "+": add a project by cloning a git repo. On success selects the
 * new project. Surfaces the server's error (e.g. AUTH_REQUIRED when no git
 * credential matches the host).
 */
export function NewProjectButton(): JSX.Element {
  const setActiveProject = useUiStore((s) => s.setActiveProject)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const raw = new FormData(event.currentTarget).get('url')
    const url = (typeof raw === 'string' ? raw : '').trim()
    if (!url) return
    setBusy(true)
    setError(null)
    try {
      const { slug } = await addProject(url)
      setActiveProject(slug)
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to add project')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!busy) setOpen(next) }}>
      <button
        onClick={() => setOpen(true)}
        title="New project"
        className="flex h-7 w-7 items-center justify-center rounded-2xl bg-surface-2 text-text-dim transition-all
          hover:rounded-[9px] hover:bg-surface-3 hover:text-accent"
      >
        <AddIcon size={14} />
      </button>

      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 w-[420px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2
          rounded-lg border border-border bg-surface-2 p-5 text-text shadow-[0_16px_48px_rgba(0,0,0,0.5)] outline-none
          transition duration-150 data-[starting-style]:scale-95 data-[starting-style]:opacity-0
          data-[ending-style]:scale-95 data-[ending-style]:opacity-0">
          <Dialog.Title className="text-sm font-semibold">Add project</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-text-dim">
            Clone a git repo as a new project.
          </Dialog.Description>
          <form onSubmit={(e) => void submit(e)} className="mt-4 flex flex-col gap-3">
            <input
              name="url"
              autoFocus
              placeholder="https://github.com/owner/repo.git"
              className="rounded-md border border-border bg-bg px-3 py-2 font-mono text-xs text-text outline-none
                focus:border-border-strong"
            />
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              <Dialog.Close
                disabled={busy}
                className="flex h-8 items-center rounded-md px-3 text-xs text-text-dim transition
                  hover:bg-surface-3 hover:text-text disabled:opacity-50"
              >
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={busy}
                className="flex h-8 items-center rounded-md bg-accent px-3 text-xs font-medium text-bg transition
                  hover:brightness-110 disabled:opacity-50"
              >
                {busy ? 'Adding…' : 'Add'}
              </button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
