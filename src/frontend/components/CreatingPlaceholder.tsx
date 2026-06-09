import type { JSX } from 'react'
import { LoadingIcon, TOOL_LABEL } from '@/frontend/lib/icons'
import { useUiStore } from '@/frontend/store'
import type { CreatingSession } from '@/frontend/store'

/** Shown in the main pane while a session provisions, in place of the
 *  terminal that will arrive. Streams progress; on failure offers dismiss. */
export function CreatingPlaceholder({ creating }: { creating: CreatingSession }): JSX.Element {
  const setCreating = useUiStore((s) => s.setCreating)

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      {creating.error ? (
        <>
          <p className="text-sm font-medium text-[#d65858]">Couldn&apos;t create session</p>
          <p className="max-w-md text-xs text-text-faint">{creating.error}</p>
          <button
            onClick={() => setCreating(null)}
            className="mt-1 rounded-md bg-surface-2 px-3 py-1.5 text-xs text-text-dim transition
              hover:bg-surface-3 hover:text-text"
          >
            Dismiss
          </button>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 text-sm text-text">
            <LoadingIcon size={15} className="animate-spin text-text-dim" />
            Creating {TOOL_LABEL[creating.tool]} session in {creating.projectSlug}
          </div>
          <p className="text-xs text-text-faint">{creating.message}</p>
        </>
      )}
    </div>
  )
}
