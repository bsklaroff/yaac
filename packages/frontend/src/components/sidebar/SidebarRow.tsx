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
 * The meta line runs the row's full width, from under the mark to the
 * right edge, so what it ends with (an agent, a badge) sits flush right;
 * the hover actions then sit at the right end of the title line above it.
 * A row with no meta keeps them centred at its right.
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
  const shown = isMobile || menuOpen
  const controls = (actions || menu) && (
    <>
      {actions}
      {menu && <RowMenu {...menu} onOpenChange={setMenuOpen} />}
    </>
  )
  // Room on the title line for the actions while they show: a button each.
  const clear = !controls ? undefined : actions && menu
    ? (shown ? 'pr-15' : 'group-hover/row:pr-15 group-focus-within/row:pr-15')
    : (shown ? 'pr-7' : 'group-hover/row:pr-7 group-focus-within/row:pr-7')
  const titleLine = (
    <span className={cn('flex min-w-0 flex-1 items-center gap-1.5 text-md', two && clear)}>
      <span className={cn('min-w-0 truncate', strong ? 'font-semibold text-text' : frame.selected ? 'text-text' : 'text-muted')}>
        {title}
      </span>
      {trailing}
    </span>
  )
  const markSlot = mark !== undefined && <span className="flex size-3.5 shrink-0 items-center justify-center">{mark}</span>
  return (
    <YRowFrame
      {...frame}
      actionsShown={shown}
      {...(!two && controls ? { actions: controls } : {})}
      className={cn('pr-2', two ? 'py-2' : 'py-[7px]', 'max-md:py-2.5',
        depth === 0 ? 'pl-2.5' : 'pl-7 before:absolute before:inset-y-0 before:left-[17px] before:w-px before:bg-line',
        className)}
    >
      {two ? (
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="relative flex min-w-0 items-center gap-1.5">
            {lead}
            {markSlot}
            {titleLine}
            {/* Inside the row's content, so clicks here, from the menu's
                portal too, must not reach the content's select handler. */}
            {controls && (
              <span
                onClick={(e) => e.stopPropagation()}
                className={cn('pointer-events-auto absolute -right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5',
                  !shown && 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100')}
              >
                {controls}
              </span>
            )}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-sm text-subtle">{meta}</span>
        </div>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {lead}
          {markSlot}
          {titleLine}
        </span>
      )}
    </YRowFrame>
  )
}
