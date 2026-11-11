import type { JSX } from 'react'
import clsx from 'clsx'
import { checkoutLabel, useCheckout } from '#lib/checkouts'
import { useUiStore } from '#lib/store'

/**
 * Picks which of a workspace's checkouts its git views show
 * (`useCheckout`): the status bar, the Changes pane and the Commits pane
 * each carry one, and all follow the same pick. Renders nothing for a
 * workspace with fewer than two checkouts.
 */
export function CheckoutSwitcher({ workspaceId, className }: { workspaceId: string; className?: string }): JSX.Element | null {
  const { repos, current } = useCheckout(workspaceId)
  const pickCheckout = useUiStore((s) => s.pickCheckout)
  if (repos.length < 2 || current === undefined) return null
  return (
    <select
      aria-label="Repo"
      title="The repo these git views show"
      value={current.path}
      onChange={(e) => pickCheckout(workspaceId, e.target.value)}
      className={clsx(
        'max-w-[140px] shrink-0 truncate rounded border border-border bg-surface-2 px-1 font-mono text-[11px] text-text '
        + 'outline-none hover:bg-surface-3',
        className,
      )}
    >
      {repos.map((r) => <option key={r.path} value={r.path}>{checkoutLabel(r.path)}</option>)}
    </select>
  )
}
