import { type JSX } from 'react'
import { Menu } from '@base-ui/react/menu'
import { AddIcon, TOOL_LABEL } from '@/frontend/lib/icons'
import { createSession } from '@/frontend/lib/createSession'
import { useUiStore } from '@/frontend/store'
import type { AgentTool } from '@/shared/types'

const TOOLS: AgentTool[] = ['claude', 'codex', 'opencode']
const ITEM = 'flex w-full cursor-default items-center rounded-md px-2 py-1.5 text-xs outline-none '
  + 'text-text-dim data-[highlighted]:bg-surface-3 data-[highlighted]:text-text'

/**
 * "+ New session" for the active project: a dropdown of tools. Picking one
 * fires the create and the menu closes immediately — provisioning progress
 * streams into the main pane (via the store's `creating` state). The new
 * session is selected on success (it also arrives live via /events).
 */
export function NewSessionButton({ projectSlug }: { projectSlug: string }): JSX.Element {
  const openSession = useUiStore((s) => s.openSession)
  const setCreating = useUiStore((s) => s.setCreating)

  const create = (tool: AgentTool): void => {
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
    <Menu.Root>
      <Menu.Trigger
        title="New session"
        className="flex h-5 w-5 items-center justify-center rounded text-text-dim transition hover:bg-surface-2
          hover:text-accent data-[popup-open]:bg-surface-2 data-[popup-open]:text-accent"
      >
        <AddIcon size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6}>
          <Menu.Popup className="min-w-[180px] rounded-lg border border-border bg-surface-2 p-1 text-text
            shadow-[0_12px_32px_rgba(0,0,0,0.5)] outline-none transition-opacity duration-100
            data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
            <div className="px-2 pb-1 pt-1 text-[11px] uppercase tracking-wide text-text-faint">New session</div>
            {TOOLS.map((t) => (
              <Menu.Item key={t} className={ITEM} onClick={() => create(t)}>
                {TOOL_LABEL[t]}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
