import { useState, type JSX } from 'react'
import { WarningIcon } from '#lib/icons'
import { useUiStore } from '#lib/store'
import { useSnapshot } from '#lib/useSnapshot'
import { parseGitRemote } from '@yaac/shared/git-remote'
import type { GitAuthFailure } from '@yaac/shared/types'
import { BADGE_TRIGGER } from '#components/ActionsBadge'
import { cn, YButton, YPopover, YPopoverPopup } from '#ui'

/**
 * Warning that a git host rejected a credential of one of the projects'
 * repos (likely expired or revoked), so git fetch/push fails there in every
 * workspace. Given several projects (Home), one badge covers them all. The
 * popover lists the hosts and links to the settings of a repo on the first
 * of them. Renders its own <button>, so inside a clickable row mount it as
 * an overlaid sibling. Its label truncates in a row short of room, leaving
 * the icon.
 */
export function GitAuthFailureBadge({
  projectIds,
  failures,
  iconSize,
  className,
}: {
  projectIds: string[]
  failures: GitAuthFailure[]
  iconSize: number
  /** Positioning and the context-appropriate hover highlight for the trigger. */
  className?: string
}): JSX.Element {
  const openSettings = useUiStore((s) => s.openSettings)
  const [open, setOpen] = useState(false)
  const repos = (useSnapshot()?.projects ?? []).filter((p) => projectIds.includes(p.id)).flatMap((p) => p.repos)
  const hostOf = (remoteUrl: string): string | undefined => {
    try {
      return parseGitRemote(remoteUrl).host
    } catch {
      return undefined
    }
  }
  const rejected = repos.find((r) => !r.hosted && failures.some((f) => f.host === hostOf(r.remoteUrl)))
  return (
    <YPopover.Root open={open} onOpenChange={setOpen}>
      <YPopover.Trigger aria-label="Git authentication failed" title="Git authentication failed" className={cn(BADGE_TRIGGER, 'bg-danger-soft text-danger', className)}>
        <WarningIcon size={iconSize} className="shrink-0" />
        <span className="truncate">git auth</span>
      </YPopover.Trigger>
      <YPopoverPopup side="bottom" align="end" sideOffset={4} className="max-w-xs">
        <div className="px-2 pb-0.5 pt-1 text-sm font-medium text-danger">
          Git authentication failed
        </div>
        <ul className="max-h-64 overflow-y-auto">
          {failures.map((f) => (
            <li key={f.host} className="truncate px-2 py-1 font-mono text-md text-muted">
              {f.host} — HTTP {f.status}
            </li>
          ))}
        </ul>
        <p className="px-2 pb-1 pt-0.5 text-md text-muted">
          A repo&apos;s git credential was rejected — it is likely expired or revoked. Assign
          the repo a new credential in Settings (running workspaces pick it up immediately),
          then retry the git command.
        </p>
        <div className="p-1">
          <YButton onClick={() => { setOpen(false); openSettings('repos', undefined, rejected?.id) }} className="w-full">
            Change git credential…
          </YButton>
        </div>
      </YPopoverPopup>
    </YPopover.Root>
  )
}
