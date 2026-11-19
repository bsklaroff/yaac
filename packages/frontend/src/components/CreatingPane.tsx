import type { JSX } from 'react'
import { USER_BUBBLE } from '#components/AcpTranscript'
import { ChatBottomBar, FilledStopIcon, Launching, useChatColumn } from '#components/ConversationView'
import { agentLabel } from '#lib/agentLabel'
import { useProjectName } from '#lib/projectIdentity'
import { dismissProvisioning, restartWorkspace } from '#lib/createWorkspace'
import { markDrawnStarting, useOpening } from '#lib/opening'
import { useUiStore, type LaunchPane } from '#lib/store'
import { useProvisionWorkspace } from '#lib/useProvisionWorkspace'
import { stopProvisioning } from '#lib/stopWorkspaceFlow'
import { PROMPT_PREVIEW_LENGTH, type ProvisioningWorkspaceEntry } from '@yaac/shared/types'
import { YButton } from '#ui'

const PANE_NAME: Record<LaunchPane, string> = { shell: 'a shell', files: 'Files', changes: 'Changes', commits: 'Commits' }

/**
 * The selected workspace's pane while it is created or restarted, drawn as
 * the chat it is about to become: the prompt it was given, then the working
 * spinner captioned with the create's progress, and Stop in the composer's
 * place. Once the workspace is listed its session's pane takes over (a chat
 * pane carries the prompt and spinner on), and a pane the create was
 * started from the bar for (`launches` in the store) opens beside it. A failure shows its error, beside the prompt so it
 * can be reused, with Dismiss. A restart refused because another running
 * workspace holds its volume (`VOLUME_HELD`) also offers to restart
 * without the volume.
 */
export function CreatingPane({ creating }: { creating: ProvisioningWorkspaceEntry }): JSX.Element {
  const removeOptimisticProvisioning = useUiStore((s) => s.removeOptimisticProvisioning)
  const selectWorkspace = useUiStore((s) => s.selectWorkspace)
  const projectName = useProjectName()
  const column = useChatColumn()
  const pane = useUiStore((s) => s.launches[creating.workspaceId]?.pane)
  const opening = useOpening(creating.sessionId, creating.prompt, PROMPT_PREVIEW_LENGTH)
  if (creating.sessionId !== undefined) markDrawnStarting(creating.sessionId)
  const provision = useProvisionWorkspace()
  // A restart refused before it started has no server row, so its code is
  // only on this tab's own.
  const ownCode = useUiStore((s) =>
    s.optimisticProvisioning.find((e) => e.workspaceId === creating.workspaceId)?.errorCode)
  const errorCode = creating.errorCode ?? ownCode
  const volumeHeld = creating.kind === 'restart' && errorCode === 'VOLUME_HELD'

  const dismiss = (): void => {
    void dismissProvisioning(creating.workspaceId).catch(() => { /* best-effort */ })
    removeOptimisticProvisioning(creating.workspaceId)
    selectWorkspace(null)
  }

  const restartWithoutVolume = (): void => {
    removeOptimisticProvisioning(creating.workspaceId)
    provision({
      workspaceId: creating.workspaceId,
      projectId: creating.projectId,
      kind: 'restart',
      ...(creating.tool !== undefined ? { tool: creating.tool } : {}),
      ...(creating.groupId !== undefined ? { groupId: creating.groupId } : {}),
    }, (onProgress) => restartWorkspace(creating.workspaceId, onProgress, null))
  }

  return (
    <div className="flex h-full w-full flex-col bg-sunken">
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className={column}>
          {creating.error === undefined ? (
            <Launching {...opening} caption={creating.stopping === true ? 'Stopping…' : creating.message} />
          ) : (
            <div className="flex flex-col items-start gap-3 break-words text-base">
              {opening?.prompt !== undefined && <div className={USER_BUBBLE}>{opening.prompt}</div>}
              <p className="text-md text-danger">
                Couldn&apos;t {creating.kind === 'restart' ? 'restart' : 'create'} the workspace: {creating.error}
              </p>
            </div>
          )}
        </div>
      </div>
      <ChatBottomBar>
        <div className="flex items-center gap-2 py-2 pl-3 pr-2">
          <span className="min-w-0 flex-1 truncate text-base text-subtle">
            {creating.error !== undefined
              ? 'The workspace did not start.'
              : `${creating.kind === 'restart' ? 'Restarting' : 'Creating'} `
                + `${creating.tool !== undefined ? `${agentLabel(creating.tool, creating)} ` : ''}`
                + `workspace in ${projectName(creating.projectId)}`
                + (pane !== undefined ? `, then opening ${PANE_NAME[pane]}` : '')}
          </span>
          {volumeHeld && (
            <YButton onClick={restartWithoutVolume}>Restart without volume</YButton>
          )}
          {creating.error !== undefined ? (
            <YButton variant="ghost" onClick={dismiss}>Dismiss</YButton>
          ) : creating.stopping !== true && (
            <YButton
              variant="primary"
              icon={FilledStopIcon}
              aria-label="Stop"
              title="Stop"
              onClick={() => stopProvisioning(creating.workspaceId)}
            />
          )}

        </div>
      </ChatBottomBar>
    </div>
  )
}
