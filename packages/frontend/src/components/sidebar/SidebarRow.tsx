import { useState, type JSX, type ReactNode } from 'react'
import { RowMenu, type RowMenuItem } from '#components/sidebar/RowMenu'
import { useIsMobile } from '#lib/viewport'
import { cn, YRowFrame, type YRowFrameProps } from '#ui'

/**
 * A row in the sidebar, drawn like the catalog's YSessionRow: a 14px mark,
 * a 13px title (muted unless `strong` or selected), and a quieter 12px
 * `meta` line, over a YRowFrame. It takes the mark as an element rather
 * than a status kind, so a status keeps StatusMark's words ("Waiting for
 * your answer") and other rows can show an icon or a spinner; a `null` mark
 * keeps the slot, so titles line up.
 *
 * `depth={1}` nests a session under its workspace on a 1px tree line under
 * the workspace's mark. `lead` holds a control in front of the mark (an
 * expand caret), drawn in the row's left padding. The hover actions end
 * with the row's `menu`, and stay shown while it is open and always on
 * touch.
 */
export function SidebarRow({ mark, title, meta, strong = false, depth = 0, trailing, lead, actions, menu, className, ...frame }: {
  mark?: ReactNode
  title: ReactNode
  meta?: ReactNode
  strong?: boolean
  depth?: 0 | 1
  /** Marks after the title. */
  trailing?: ReactNode
  lead?: ReactNode
  menu?: { label: string; items: RowMenuItem[] }
} & Omit<YRowFrameProps, 'children' | 'actionsShown'>): JSX.Element {
  const isMobile = useIsMobile()
  const [menuOpen, setMenuOpen] = useState(false)
  const two = meta !== undefined
  return (
    <YRowFrame
      {...frame}
      actionsShown={isMobile || menuOpen}
      actions={(actions || menu) && (
        <>
          {actions}
          {menu && <RowMenu {...menu} onOpenChange={setMenuOpen} />}
        </>
      )}
      className={cn('pr-2', two ? 'py-2' : 'py-[7px]', 'max-md:py-2.5',
        depth === 0 ? 'pl-2.5' : 'pl-7 before:absolute before:inset-y-0 before:left-[17px] before:w-px before:bg-line',
        className)}
    >
      {lead}
      {mark !== undefined && (
        <span className={cn('flex size-3.5 shrink-0 items-center justify-center', two && 'mt-px self-start')}>{mark}</span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex min-w-0 items-center gap-1.5 text-md">
          <span className={cn('min-w-0 truncate', strong ? 'font-semibold text-text' : frame.selected ? 'text-text' : 'text-muted')}>
            {title}
          </span>
          {trailing}
        </span>
        {two && <span className="flex min-w-0 items-center gap-2 text-sm text-subtle">{meta}</span>}
      </div>
    </YRowFrame>
  )
}
