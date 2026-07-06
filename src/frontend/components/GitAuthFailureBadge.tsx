import type { JSX } from 'react'
import clsx from 'clsx'
import { Popover } from '@base-ui/react/popover'
import { WarningIcon } from '@/frontend/lib/icons'
import type { GitAuthFailure } from '@/shared/types'

/**
 * Loud project-wide indicator that the upstream rejected the git credential
 * the proxy injected (expired or revoked token) — git fetch/push is failing
 * in every one of the project's sessions. Clicking opens a popover naming
 * the host and the fix. Renders its own <button>, so inside clickable rows
 * mount it as an overlaid sibling (like BlockedHostsBadge), never nested in
 * the row button.
 */
export function GitAuthFailureBadge({
  failures,
  iconSize,
  className,
}: {
  failures: GitAuthFailure[]
  iconSize: number
  /** Positioning and the context-appropriate hover highlight for the trigger. */
  className?: string
}): JSX.Element {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Git authentication failed"
        className={clsx(
          'flex shrink-0 items-center gap-1 rounded bg-[#d65858]/15 px-1 py-0.5 text-xs font-medium text-[#d65858] transition',
          className,
        )}
      >
        <WarningIcon size={iconSize} />
        git auth
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4}>
          <Popover.Popup className="max-w-xs rounded-lg border border-border bg-surface-2 p-1 text-text
            shadow-[0_12px_32px_rgba(0,0,0,0.5)] outline-none transition-opacity duration-100
            data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
            <div className="px-2 pb-0.5 pt-1 text-[11px] font-medium text-[#d65858]">
              Git authentication failed
            </div>
            <ul className="max-h-64 overflow-y-auto">
              {failures.map((f) => (
                <li key={f.host} className="truncate px-2 py-1 font-mono text-xs text-text-dim">
                  {f.host} — HTTP {f.status}
                </li>
              ))}
            </ul>
            <p className="px-2 pb-1 pt-0.5 text-xs text-text-dim">
              The stored token was rejected — it is likely expired or revoked. Run{' '}
              <code className="font-mono text-text">yaac auth update</code> to replace it
              (running sessions pick it up immediately), then retry the git command.
            </p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
