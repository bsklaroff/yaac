import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { Dialog } from '@base-ui/react/dialog'
import { AddIcon } from '@/frontend/lib/icons'
import { createSession } from '@/frontend/lib/createSession'
import { useUiStore } from '@/frontend/store'
import type { AgentTool } from '@/shared/types'

const TOOLS: AgentTool[] = ['claude', 'codex', 'opencode']

/**
 * "+ New session" for the active project. Picks the tool, then fires the
 * create and closes immediately — provisioning progress streams into the
 * main pane (via the store's `creating` state), not the modal. The new
 * session is selected on success (it also arrives live via /events).
 */
export function NewSessionButton({ projectSlug }: { projectSlug: string }): JSX.Element {
  const openSession = useUiStore((s) => s.openSession)
  const setCreating = useUiStore((s) => s.setCreating)
  const [open, setOpen] = useState(false)
  const [tool, setTool] = useState<AgentTool>('claude')

  const create = (): void => {
    setOpen(false)
    setCreating({ projectSlug, tool, message: 'Starting…' })
    void createSession(projectSlug, tool, (message) => {
      setCreating({ projectSlug, tool, message })
    })
      .then((result) => {
        setCreating(null)
        openSession(projectSlug, result.sessionId)
      })
      .catch((e: unknown) => {
        setCreating({ projectSlug, tool, message: '', error: e instanceof Error ? e.message : 'create failed' })
      })
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <button
        onClick={() => setOpen(true)}
        title="New session"
        className="flex h-5 w-5 items-center justify-center rounded text-text-dim transition hover:bg-surface-2 hover:text-accent"
      >
        <AddIcon size={14} />
      </button>

      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 w-[360px] -translate-x-1/2 -translate-y-1/2 rounded-lg border
          border-border bg-surface-2 p-5 text-text shadow-[0_16px_48px_rgba(0,0,0,0.5)] outline-none transition duration-150
          data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0">
          <Dialog.Title className="text-sm font-semibold">New session</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-text-dim">
            in <span className="text-text">{projectSlug}</span>
          </Dialog.Description>

          <div className="mt-4 flex gap-1 rounded-lg bg-bg p-1">
            {TOOLS.map((t) => (
              <button
                key={t}
                onClick={() => setTool(t)}
                className={clsx(
                  'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition',
                  tool === t ? 'bg-surface-3 text-text' : 'text-text-dim hover:text-text',
                )}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close className="flex h-8 items-center rounded-md px-3 text-xs text-text-dim transition
              hover:bg-surface-3 hover:text-text">
              Cancel
            </Dialog.Close>
            <button
              onClick={create}
              className="flex h-8 items-center rounded-md bg-accent px-3 text-xs font-medium text-bg transition
                hover:brightness-110"
            >
              Create
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
