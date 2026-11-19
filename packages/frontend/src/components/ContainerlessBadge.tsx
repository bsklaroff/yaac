import type { JSX } from 'react'
import clsx from 'clsx'
import { useSnapshot } from '#lib/useSnapshot'
import { CONTAINERLESS_REACH } from '@yaac/shared/setup-copy'
import { BADGE_TRIGGER } from '#components/ActionsBadge'
import { YPopover, YPopoverPopup } from '#ui'

/**
 * Warning that this server runs workspaces on its machine with no sandbox
 * (docs/containerless-driver.md), drawn in a live workspace's Details pane
 * and a read-only workspace's header, and by nothing under k8s. The driver is the server's, so
 * a client of a remote containerless server sees it too. The popover says
 * what the agent can reach and where isolation comes from.
 */
export function ContainerlessBadge(): JSX.Element | null {
  if (useSnapshot()?.driver !== 'containerless') return null
  return (
    <YPopover.Root>
      <YPopover.Trigger
        aria-label="Containerless workspace: not sandboxed"
        title="Not sandboxed: click for details"
        className={clsx(BADGE_TRIGGER, 'bg-warning-soft text-warning hover:bg-warning/25 data-[popup-open]:bg-warning/25')}
      >
        containerless
      </YPopover.Trigger>
      <YPopoverPopup side="bottom" align="end" sideOffset={4} className="max-w-xs">
        <div className="px-2 pb-1 pt-1 text-md font-medium text-warning">Not sandboxed</div>
        <div className="flex flex-col gap-1.5 px-2 pb-1.5 text-md leading-relaxed text-muted">
          <p>
            This server runs workspaces directly on its machine, with no container. The agent
            acts as the account the yaac server runs as:
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            {CONTAINERLESS_REACH.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <p>
            Pick the permission mode with that in mind. For isolated workspaces, use a k8s
            install (
            <code className="font-mono text-text">yaac cluster install</code>
            ), which runs each workspace in a sandboxed pod. It needs a machine that can run
            podman and kind.
          </p>
        </div>
      </YPopoverPopup>
    </YPopover.Root>
  )
}
