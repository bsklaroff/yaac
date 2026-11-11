import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { PopoverPopup } from '#components/ui/menu'
import { Popover } from '@base-ui/react/popover'
import { WarningIcon } from '#lib/icons'
import { useUiStore } from '#lib/store'
import { useSnapshot } from '#lib/useSnapshot'
import { parseGitRemote } from '@yaac/shared/git-remote'
import type { GitAuthFailure } from '@yaac/shared/types'

/**
 * Project-wide warning that a git host rejected a credential of one of the
 * project's repos (likely expired or revoked), so git fetch/push fails
 * there in every workspace. The popover lists the hosts and links to the
 * settings of the project's repo on the first of them. Renders its own
 * <button>, so inside a clickable row mount it as an overlaid sibling.
 */
export function GitAuthFailureBadge({
  projectId,
  failures,
  iconSize,
  className,
}: {
  projectId: string
  failures: GitAuthFailure[]
  iconSize: number
  /** Positioning and the context-appropriate hover highlight for the trigger. */
  className?: string
}): JSX.Element {
  const openSettings = useUiStore((s) => s.openSettings)
  const [open, setOpen] = useState(false)
  const repos = useSnapshot()?.projects.find((p) => p.id === projectId)?.repos ?? []
  const hostOf = (remoteUrl: string): string | undefined => {
    try {
      return parseGitRemote(remoteUrl).host
    } catch {
      return undefined
    }
  }
  const rejected = repos.find((r) => !r.hosted && failures.some((f) => f.host === hostOf(r.remoteUrl)))
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
      <PopoverPopup side="bottom" align="end" sideOffset={4} className="max-w-xs">
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
          A repo&apos;s git credential was rejected — it is likely expired or revoked. Assign
          the repo a new credential in Settings (running workspaces pick it up immediately),
          then retry the git command.
        </p>
        <div className="p-1">
          <button
            type="button"
            onClick={() => { setOpen(false); openSettings('repos', undefined, rejected?.id) }}
            className="w-full rounded-md border border-border-strong bg-surface-3 px-2 py-1.5 text-xs font-medium
              text-text transition hover:bg-border-strong"
          >
            Change git credential…
          </button>
        </div>
      </PopoverPopup>
    </Popover.Root>
  )
}
