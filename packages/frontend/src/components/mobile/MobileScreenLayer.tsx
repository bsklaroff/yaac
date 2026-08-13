import type { JSX, ReactNode } from 'react'
import clsx from 'clsx'

/**
 * One of the mobile shell's stacked screens.
 *
 * All three screens stay mounted and stay *laid out*; only one is visible.
 * That is not an optimization, it is a correctness requirement for the pane:
 * WorktreeView positions every terminal by measured pixels (a ResizeObserver
 * feeds `computeColumns`, which feeds each pane's absolute rect), so a
 * `display: none` ancestor would collapse every rect to zero and make coming
 * back cost a full resize round-trip to the pod. `visibility: hidden` keeps
 * the box measured — the same trick WorktreeView already uses for its own
 * off-screen panes.
 *
 * Deliberately not a translated `300vw` strip, tempting as the slide
 * animation is: a transformed ancestor becomes the containing block for
 * `position: fixed` descendants, which would silently relocate any
 * non-portaled overlay inside a screen.
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
