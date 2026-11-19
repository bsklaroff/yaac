import type { JSX } from 'react'
import clsx from 'clsx'
import { checkoutLabel, useCheckout } from '#lib/checkouts'
import { useUiStore } from '#lib/store'
import { YSelect } from '#ui'

/**
 * Picks which of a workspace's checkouts its git views show
 * (`useCheckout`): the git status, the Changes pane and the Commits pane
 * each carry one, and all follow the same pick. Renders nothing for a
 * workspace with fewer than two checkouts.
 */
export function CheckoutSwitcher({ workspaceId, className }: { workspaceId: string; className?: string }): JSX.Element | null {
  const { repos, current } = useCheckout(workspaceId)
  const pickCheckout = useUiStore((s) => s.pickCheckout)
  if (repos.length < 2 || current === undefined) return null
  return (
    <YSelect
      aria-label="Repo"
      title="The repo these git views show"
      value={current.path}
      onChange={(e) => pickCheckout(workspaceId, e.target.value)}
      className={clsx('max-w-[140px] shrink-0 truncate font-mono', className)}
    >
      {repos.map((r) => <option key={r.path} value={r.path}>{checkoutLabel(r.path)}</option>)}
    </YSelect>
  )
}
