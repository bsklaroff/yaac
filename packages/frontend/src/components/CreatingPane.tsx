import { useState, type JSX, type ReactNode } from 'react'
import { StopIcon } from '#lib/icons'
import { USER_BUBBLE } from '#components/AcpTranscript'
import { ChatBottomBar, Launching, ROUND_BUTTON, useChatColumn } from '#components/ConversationView'
import { agentLabel } from '#lib/agentLabel'
import { useProjectName } from '#lib/projectIdentity'
import { dismissProvisioning } from '#lib/createWorkspace'
import { useUiStore, type LaunchPane } from '#lib/store'
import { stopProvisioning } from '#lib/stopWorkspaceFlow'
import { TOOL_LABELS, type ProvisioningWorkspaceEntry, type WorkspaceListEntry } from '@yaac/shared/types'

const PANE_NAME: Record<LaunchPane, string> = { shell: 'a shell', files: 'Files', changes: 'Changes' }

/**
 * The selected workspace's pane while it is created or restarted, drawn as
 * the chat it is about to become: the prompt it was given, then the working
 * spinner captioned with the create's progress, and Stop in the composer's
 * place. Once the workspace is listed its own pane takes over: a chat pane
 * carries the prompt and spinner on (`launches` in the store), a
 * terminal replaces this, and a pane the create was started from the bar
 * for opens beside it. A failure shows its error, beside the prompt so it
 * can be reused, with Dismiss.
 */
export function CreatingPane({ creating }: { creating: ProvisioningWorkspaceEntry }): JSX.Element {
  const removeOptimisticProvisioning = useUiStore((s) => s.removeOptimisticProvisioning)
  const selectWorkspace = useUiStore((s) => s.selectWorkspace)
  const projectName = useProjectName()
  const column = useChatColumn()
  const pane = useUiStore((s) => s.launches[creating.workspaceId]?.pane)
  const prompt = creating.prompt ? { prompt: creating.prompt } : {}

  const dismiss = (): void => {
    void dismissProvisioning(creating.workspaceId).catch(() => { /* best-effort */ })
    removeOptimisticProvisioning(creating.workspaceId)
    selectWorkspace(null)
  }

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className={column}>
          {creating.error === undefined ? (
            <Launching {...prompt} caption={creating.stopping === true ? 'Stopping…' : creating.message} />
          ) : (
            <div className="flex flex-col items-start gap-3 break-words text-sm">
              {creating.prompt && <div className={USER_BUBBLE}>{creating.prompt}</div>}
              <p className="text-xs text-danger">
                Couldn&apos;t {creating.kind === 'restart' ? 'restart' : 'create'} the workspace: {creating.error}
              </p>
            </div>
          )}
        </div>
      </div>
      <ChatBottomBar>
        <div className="flex items-center gap-2 py-2 pl-3 pr-2">
          <span className="min-w-0 flex-1 truncate text-sm text-text-faint">
            {creating.error !== undefined
              ? 'The workspace did not start.'
              : `${creating.kind === 'restart' ? 'Restarting' : 'Creating'} ${agentLabel(creating.tool, creating)}`
                + ` workspace in ${projectName(creating.projectId)}`
                + (pane !== undefined ? `, then opening ${PANE_NAME[pane]}` : '')}
          </span>
          {creating.error !== undefined ? (
            <button
              type="button"
              onClick={dismiss}
              className="rounded-md bg-surface-2 px-3 py-1.5 text-xs text-text-dim transition hover:bg-surface-3
                hover:text-text"
            >
              Dismiss
            </button>
          ) : creating.stopping !== true && (
            <button
              type="button"
              aria-label="Stop"
              title="Stop"
              onClick={() => stopProvisioning(creating.workspaceId)}
              className={ROUND_BUTTON}
            >
              <StopIcon size={11} fill="currentColor" />
            </button>
          )}
        </div>
      </ChatBottomBar>
    </div>
  )
}

/**
 * The agent pane of an `acp` workspace that is listed before its agent has
 * named a conversation (`session/new`): drawn as the create's pane was, the
 * prompt it was created with and then the spinner. The chat pane
 * replaces it once the conversation is recorded (`syncPaneLayout`) and
 * carries the prompt and spinner on. For any other workspace, or once the
 * user asks for it, this is `children`, the agent window's terminal, which
 * under `acp` shows acpd's log: the place to look when the agent never
 * comes up.
 */
export function AcpStartingPane({ workspace, children }: {
  workspace: WorkspaceListEntry | undefined
  children: ReactNode
}): JSX.Element {
  const [showLog, setShowLog] = useState(false)
  const launched = useUiStore((s) => (workspace ? s.launches[workspace.workspaceId]?.prompt : undefined))
  const prompt = launched ?? workspace?.prompt
  const column = useChatColumn()
  if (workspace?.mode !== 'acp' || showLog) return <>{children}</>

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-md bg-bg">
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className={column}>
          <Launching {...(prompt !== undefined ? { prompt } : {})} caption={`Starting ${TOOL_LABELS[workspace.tool]}…`} />
        </div>
      </div>
      <ChatBottomBar>
        <div className="flex items-center gap-2 py-2 pl-3 pr-2">
          <span className="min-w-0 flex-1 truncate text-sm text-text-faint">
            The chat opens once the agent is up.
          </span>
          <button
            type="button"
            onClick={() => setShowLog(true)}
            className="rounded-md bg-surface-2 px-3 py-1.5 text-xs text-text-dim transition hover:bg-surface-3
              hover:text-text"
          >
            Show log
          </button>
        </div>
      </ChatBottomBar>
    </div>
  )
}
