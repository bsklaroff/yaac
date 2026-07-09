import { type JSX } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Menu } from '@base-ui/react/menu'
import { AddIcon, TOOL_LABEL } from '@/frontend/lib/icons'
import { createSession } from '@/frontend/lib/createSession'
import { useProvisionSession } from '@/frontend/lib/useProvisionSession'
import { AUTH_LIST_KEY, configuredTools, useAuthList } from '@/frontend/lib/useAuthList'
import { useUiStore } from '@/frontend/store'
import type { AgentTool } from '@/shared/types'

const TOOLS: AgentTool[] = ['claude', 'codex', 'opencode']
const ITEM = 'flex w-full cursor-default items-center rounded-md px-2 py-1.5 text-xs outline-none '
  + 'text-text-dim data-[highlighted]:bg-surface-3 data-[highlighted]:text-text'

/**
 * "+ New session" for the active project: a dropdown of tools. Picking one
 * fires the create and the menu closes immediately — a provisioning row appears
 * in the sidebar and is auto-opened so progress streams into the main pane. The
 * id is generated up front so the row is selectable and survives a reload.
 *
 * Tools without a stored credential can't create: their item reads "Sign in"
 * and opens settings → credentials with that tool's form expanded instead.
 */
export function NewSessionButton({ projectSlug }: { projectSlug: string }): JSX.Element {
  const provision = useProvisionSession()
  const auth = useAuthList()
  const configured = configuredTools(auth)
  const openSettings = useUiStore((s) => s.openSettings)
  const queryClient = useQueryClient()

  const create = (tool: AgentTool): void => {
    const sessionId = crypto.randomUUID()
    provision(projectSlug, tool, 'create', sessionId,
      (sid, onProgress) => createSession(projectSlug, tool, onProgress, sid))
  }

  return (
    <Menu.Root onOpenChange={(open) => {
      // Credentials may have changed daemon-side (CLI login, another tab)
      // since the app-start fetch — re-pull while the menu is up.
      if (open) void queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY })
    }}>
      <Menu.Trigger
        title="New session"
        className="flex h-5 w-5 items-center justify-center rounded text-text-dim transition hover:bg-surface-2
          hover:text-accent data-[popup-open]:bg-surface-2 data-[popup-open]:text-accent"
      >
        <AddIcon size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        {/* align=start: the popup extends right (over the pane area) instead of
            left across the sidebar content. */}
        <Menu.Positioner side="bottom" align="start" sideOffset={6}>
          <Menu.Popup className="min-w-[180px] rounded-lg border border-border bg-surface-2 p-1 text-text
            shadow-[0_12px_32px_var(--shadow-color)] outline-none transition-opacity duration-100
            data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
            <div className="px-2 pb-1 pt-1 text-[11px] uppercase tracking-wide text-text-faint">New session</div>
            {TOOLS.map((t) => configured.has(t) ? (
              <Menu.Item key={t} className={ITEM} onClick={() => create(t)}>
                {TOOL_LABEL[t]}
              </Menu.Item>
            ) : (
              <Menu.Item key={t} className={ITEM} onClick={() => openSettings('credentials', t)}>
                <span className="text-text-faint">{TOOL_LABEL[t]}</span>
                <span className="ml-auto pl-3 text-[11px] text-accent">Sign in</span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
