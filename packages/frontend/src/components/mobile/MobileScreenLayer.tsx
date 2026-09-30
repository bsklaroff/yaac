import type { JSX, ReactNode } from 'react'
import clsx from 'clsx'

/**
 * One of the stacked mobile screens. All screens stay mounted and laid out;
 * inactive ones use `visibility: hidden` rather than `display: none`, because
 * WorkspaceView sizes terminals from measured pixels and a zero-size box
 * would force a resize round-trip on return.
 *
 * No slide transform: a transformed ancestor becomes the containing block for
 * `position: fixed` children and would misplace non-portaled overlays.
 */
export function MobileScreenLayer({
  active,
  children,
}: {
  active: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <div
      inert={!active}
      className={clsx(
        'absolute inset-0 flex flex-col bg-shell',
        !active && 'invisible pointer-events-none',
      )}
    >
      {children}
    </div>
  )
}
