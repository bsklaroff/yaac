import { useEffect, useState, type JSX } from 'react'
import { useFindChord } from '#components/ConversationFind'
import { ReadOnlyTranscript } from '#components/ReadOnlyTranscript'
import { useUiStore } from '#lib/store'
import type { AgentSessionEntry } from '@yaac/shared/types'

/**
 * Cmd/Ctrl-F in a `tui` agent's pane. The terminal holds only the screens
 * tmux last drew, so the search runs over the tool's own history instead:
 * its conversations, read as a stopped workspace's are and refreshed while
 * the workspace runs, laid over the terminal until the find bar closes or
 * the pane leaves the screen, so a hidden pane never keeps refreshing it.
 */
export function TuiTranscriptSearch({ workspaceId, sessions, visible, focused }: {
  workspaceId: string
  sessions: AgentSessionEntry[]
  visible: boolean
  /** The pane the user is in, which Cmd/Ctrl-F searches. */
  focused: boolean
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  useFindChord(focused && !open, () => setOpen(true))
  useEffect(() => {
    if (!visible) setOpen(false)
  }, [visible])
  if (!open) return null
  return (
    <div className="absolute inset-0 flex flex-col bg-bg">
      <ReadOnlyTranscript
        workspaceId={workspaceId}
        sessions={sessions.filter((s) => s.mode !== 'acp')}
        live
        find={{
          chord: focused,
          defaultOpen: true,
          onClose: () => {
            setOpen(false)
            useUiStore.getState().focusTerminal(workspaceId, 'agent')
          },
        }}
      />
    </div>
  )
}
