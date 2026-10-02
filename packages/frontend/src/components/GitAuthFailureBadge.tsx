import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { POPUP } from '#components/ui/menu'
import { Popover } from '@base-ui/react/popover'
import { WarningIcon } from '#lib/icons'
import { useUiStore } from '#lib/store'
import type { GitAuthFailure } from '@yaac/shared/types'

/**
 * Project-wide warning that the git host rejected the project's credential
 * (likely expired or revoked), so git fetch/push fails in every workspace.
 * The popover lists the hosts and links to credential settings. Renders its
 * own <button>, so inside a clickable row mount it as an overlaid sibling.
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
          'flex shrink-0 items-center gap-1 rounded bg-danger/15 px-1 py-0.5 text-xs font-medium text-danger transition',
          className,
        )}
      >
        <WarningIcon size={iconSize} />
        git auth
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4}>
          <Popover.Popup className={clsx('max-w-xs', POPUP)}>
            <div className="px-2 pb-0.5 pt-1 text-[11px] font-medium text-danger">
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
              the project a new credential in Settings (running workspaces pick it up immediately),
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
