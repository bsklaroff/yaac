import type { JSX } from 'react'
import { useUiStore } from '@/frontend/store'
import type { SessionListEntry } from '@/shared/types'

/**
 * In-app `session stream`: jump to the next session awaiting input, across
 * all projects (switching the active project as needed). Cycles through the
 * waiting set from the current selection. yaac's core triage loop.
 */
export function NextWaitingButton({ waiting }: { waiting: SessionListEntry[] }): JSX.Element | null {
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const openSession = useUiStore((s) => s.openSession)

  if (waiting.length === 0) return null

  const goNext = (): void => {
    const idx = waiting.findIndex((s) => s.sessionId === selectedSessionId)
    const next = waiting[(idx + 1) % waiting.length]
    openSession(next.projectSlug, next.sessionId)
  }

  return (
    <button
      onClick={goNext}
      title="Jump to the next session awaiting input"
      className="flex w-full items-center gap-2 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium
        text-amber-300 transition hover:bg-amber-500/20"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
      <span>{waiting.length} waiting</span>
      <span className="ml-auto text-amber-200/80">next →</span>
    </button>
  )
}
