import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { Dialog } from '@base-ui/react/dialog'
import { AddIcon } from '@/frontend/lib/icons'
import { createSession } from '@/frontend/lib/createSession'
import { useUiStore } from '@/frontend/store'
import type { AgentTool } from '@/shared/types'

const TOOLS: AgentTool[] = ['claude', 'codex', 'opencode']

/**
 * "+ New session" for the active project. A Base UI Dialog picks the tool,
 * then streams `POST /session/create` progress and selects the new session
 * on success (it also arrives live via the events stream).
 */
export function NewSessionButton({ projectSlug }: { projectSlug: string }): JSX.Element {
  const selectSession = useUiStore((s) => s.selectSession)
  const [open, setOpen] = useState(false)
  const [tool, setTool] = useState<AgentTool>('claude')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setProgress('Creating…')
    try {
      const result = await createSession(projectSlug, tool, setProgress)
      selectSession(result.sessionId)
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create failed')
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!busy) setOpen(next) }}>
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
                disabled={busy}
                className={clsx(
                  'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition',
                  tool === t ? 'bg-surface-3 text-text' : 'text-text-dim hover:text-text',
                )}
              >
                {t}
              </button>
            ))}
          </div>

          {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

          <div className="mt-5 flex items-center justify-end gap-2">
            {busy && <span className="mr-auto truncate text-xs text-text-faint">{progress}</span>}
            <Dialog.Close
              disabled={busy}
              className="flex h-8 items-center rounded-md px-3 text-xs text-text-dim transition
                hover:bg-surface-3 hover:text-text disabled:opacity-50"
            >
              Cancel
            </Dialog.Close>
            <button
              onClick={() => void create()}
              disabled={busy}
              className="flex h-8 items-center rounded-md bg-accent px-3 text-xs font-medium text-bg transition
                hover:brightness-110 disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
