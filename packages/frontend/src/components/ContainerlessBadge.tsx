import type { JSX } from 'react'
import clsx from 'clsx'
import { Popover } from '@base-ui/react/popover'
import { POPUP } from '#components/ui/menu'
import { useSnapshot } from '#lib/useSnapshot'

/**
 * Workspace-bar warning that this server runs workspaces on its machine with
 * no sandbox (docs/containerless-driver.md), drawn by every workspace header,
 * live or read-only, and by nothing under k8s. The driver is the server's, so
 * a client of a remote containerless server sees it too. The popover says
 * what the agent can reach and where isolation comes from.
 */
export function ContainerlessBadge(): JSX.Element | null {
  if (useSnapshot()?.driver !== 'containerless') return null
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Containerless workspace: not sandboxed"
        title="Not sandboxed: click for details"
        className="flex shrink-0 items-center rounded bg-warning/15 px-1 py-0.5 text-xs font-semibold
          uppercase tracking-wide text-warning ring-1 ring-warning/40 transition hover:bg-warning/25
          data-[popup-open]:bg-warning/25"
      >
        containerless
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4}>
          <Popover.Popup className={clsx('max-w-xs', POPUP)}>
            <div className="px-2 pb-1 pt-1 text-xs font-medium text-warning">Not sandboxed</div>
            <div className="flex flex-col gap-1.5 px-2 pb-1.5 text-xs leading-relaxed text-text-dim">
              <p>
                This server runs workspaces directly on its machine, with no container. The agent
                acts as the account the yaac server runs as:
              </p>
              <ul className="list-disc space-y-0.5 pl-4">
                <li>it can read and change any file that account can, not just this checkout</li>
                <li>it holds real credentials and tokens: every project&apos;s on this server, not only this one&apos;s</li>
                <li>its network access is unfiltered</li>
                <li>it can read and change every other workspace on this server, and drive the yaac server itself</li>
              </ul>
              <p>
                Pick the permission mode with that in mind. For isolated workspaces, use a k8s
                install (
                <code className="font-mono text-text">yaac cluster install</code>
                ), which runs each workspace in a sandboxed pod. It needs a machine that can run
                podman and kind.
              </p>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
