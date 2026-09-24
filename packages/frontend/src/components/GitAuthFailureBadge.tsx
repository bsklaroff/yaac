import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { Popover } from '@base-ui/react/popover'
import { WarningIcon } from '#lib/icons'
import { useUiStore } from '#store'
import type { GitAuthFailure } from '@yaac/shared/types'

/**
 * Loud project-wide indicator that the upstream rejected the git credential
 * the proxy injected (expired or revoked token) — git fetch/push is failing
 * in every one of the project's worktrees. Clicking opens a popover naming
 * the host and the fix: assigning the project a new credential, which the
 * popover's button opens settings onto. Renders its own <button>, so inside clickable rows
 * mount it as an overlaid sibling (like BlockedHostsBadge), never nested in
 * the row button.
 */
export function GitAuthFailureBadge({
  projectSlug,
  failures,
  iconSize,
  className,
}: {
  projectSlug: string
  failures: GitAuthFailure[]
  iconSize: number
  /** Positioning and the context-appropriate hover highlight for the trigger. */
  className?: string
}): JSX.Element {
  const openSettings = useUiStore((s) => s.openSettings)
  const [open, setOpen] = useState(false)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
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
            shadow-[0_12px_32px_var(--shadow-color)] outline-none transition-opacity duration-100
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
              The project's git credential was rejected — it is likely expired or revoked. Assign
              the project a new credential in Settings (running worktrees pick it up immediately),
              then retry the git command.
            </p>
            <div className="p-1">
              <button
                type="button"
                onClick={() => { setOpen(false); openSettings('credentials', undefined, projectSlug) }}
                className="w-full rounded-md border border-border-strong bg-surface-3 px-2 py-1.5 text-xs font-medium
                  text-text transition hover:bg-border-strong"
              >
                Change git credential…
              </button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
