import type { JSX } from 'react'
import clsx from 'clsx'
import { PortIcon } from '#lib/icons'
import { api } from '#lib/api'
import { ActionsBadge } from '#components/ui/ActionsBadge'

/**
 * Badge for ports listening inside the workspace that are not forwarded. Its
 * popover lists them; each can be forwarded for this workspace, forwarded
 * for the project (saved to yaac-config.json, and forwarded in the project's
 * other running workspaces), or dismissed until the server restarts.
 * Forwarding makes the server offer the port; a client holds the listener
 * (docs/port-forward-tunnel.md).
 *
 * The header shows the server's bind host (`forwardBindHost`), not the page
 * origin, because the page may be reached by another name (e.g. an SSH
 * tunnel).
 */
export function UnforwardedPortsBadge({
  ports,
  workspaceId,
  exposeHost,
  iconSize,
  className,
}: {
  ports: number[]
  /** The workspace the listeners were detected in — the target of the actions. */
  workspaceId: string
  /** The host this install's forwarder binds (snapshot `forwardBindHost`). */
  exposeHost: string
  iconSize: number
  /** Positioning and the context-appropriate hover highlight for the trigger. */
  className?: string
}): JSX.Element {
  const ws = api.workspace[':id']
  const param = { id: workspaceId }
  const local = exposeHost === '127.0.0.1' || exposeHost === '::1'
  return (
    <ActionsBadge
      label={`${ports.length} detected port${ports.length === 1 ? '' : 's'}`}
      icon={<PortIcon size={iconSize} />}
      className={clsx('bg-surface-2 text-text-dim', className)}
      header={(
        <>
          <div className="px-2 pb-0.5 pt-1 text-[11px] font-medium text-text-faint">Detected ports</div>
          <div className="px-2 pb-1 text-[11px] text-text-faint">
            Servers listening in the workspace. Forwarding exposes them at
            {' '}
            <span className="font-mono">http://{local ? 'localhost' : exposeHost}</span>
            {local ? ' (this machine only)' : ' (reachable by anything that can reach that address)'}
            .
          </div>
        </>
      )}
      items={ports}
      itemLabel={(port) => `:${port}`}
      actions={(containerPort) => [
        {
          label: 'Forward for this workspace',
          run: () => ws['forward-port'].$post({ param, json: { containerPort, persist: false } }),
        },
        {
          label: 'Forward permanently for this project',
          run: () => ws['forward-port'].$post({ param, json: { containerPort, persist: true } }),
        },
        { label: 'Dismiss', run: () => ws['dismiss-port'].$post({ param, json: { containerPort } }) },
      ]}
    />
  )
}
