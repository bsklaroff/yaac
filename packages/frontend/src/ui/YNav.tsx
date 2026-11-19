import { useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type JSX, type ReactNode, type Ref } from 'react'
import { cn } from './cn'
import { Dialog } from '@base-ui/react/dialog'
import { AddIcon, ChevronIcon, SearchIcon } from '#lib/icons'
import { useOpenerFocus } from '#lib/useOpenerFocus'
import { YKbd } from './YKbd'
import { YTooltip } from './YTooltip'
import type { YIconGlyph } from './types'

/*
 * The app's frame: the rail, the sidebar, the top bar over the work area,
 * and the command palette.
 */

/** The rail: a narrow column of the overview, the projects, and at the
 *  foot the logo menu. Its items and project tiles are 44px squares that
 *  stack flush and fill its width. */
export function YProjectRail({ top, children, bottom, className }: {
  top?: ReactNode
  children?: ReactNode
  bottom?: ReactNode
  className?: string
}): JSX.Element {
  return (
    // 45px: the 44px items and tiles, plus the 1px line on the right. The
    // middle never scrolls sideways, so no horizontal scrollbar can appear.
    <nav aria-label="Projects" className={cn('flex w-[45px] shrink-0 flex-col border-r border-line bg-shell', className)}>
      {top && <div className="flex w-full flex-col">{top}</div>}
      <div className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto overflow-x-hidden">{children}</div>
      {bottom && <div className="flex w-full flex-col">{bottom}</div>}
    </nav>
  )
}

/** A rail button: an icon (or `children`, such as a project tile) with a
 *  tooltip (`tip`, else `label`), filled while `active`, with an amber dot
 *  when something there needs you. Other button props and `ref` pass
 *  through, for a draggable tile. */
export function YRailItem({ icon: IconGlyph, label, tip, active = false, dot = false, children, className, ref, ...props }: {
  icon?: YIconGlyph
  label: string
  tip?: ReactNode
  active?: boolean
  dot?: boolean
  children?: ReactNode
  className?: string
  ref?: Ref<HTMLButtonElement>
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>): JSX.Element {
  return (
    <YTooltip tip={tip ?? label} side="right">
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-current={active || undefined}
        {...props}
        className={cn('relative flex h-11 w-11 shrink-0 items-center justify-center text-muted outline-none transition-colors',
          'hover:bg-hover hover:text-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
          active && 'bg-selected text-text', className)}
      >
        {IconGlyph && <IconGlyph size={16} strokeWidth={1.75} aria-hidden />}
        {children}
        {dot && <span aria-hidden className="absolute right-1.5 top-1.5 h-1.5 w-1.5 bg-warning" />}
      </button>
    </YTooltip>
  )
}

/** The sidebar: a header, the New session row (`newSession`, usually a
 *  YSidebarNewSession), its sections, and at the foot a way to all
 *  sessions. */
export function YSidebar({ header, newSession, children, footer, width, className }: {
  header?: ReactNode
  newSession?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
  className?: string
}): JSX.Element {
  return (
    <aside className={cn('relative flex shrink-0 flex-col border-r border-line bg-shell', className)} style={width ? { width } : undefined}>
      {header}
      {newSession && <div className="px-1.5 pt-1.5">{newSession}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">{children}</div>
      {footer}
    </aside>
  )
}

/** The sidebar's New session row. Pass-through props and `ref` let a menu
 *  trigger render it. */
export function YSidebarNewSession({ kbd, className, ref, ...props }: {
  kbd?: string
  className?: string
  ref?: Ref<HTMLButtonElement>
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>): JSX.Element {
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      className={cn('flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-md text-text outline-none hover:bg-hover',
        'focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 data-[popup-open]:bg-selected', className)}
    >
      <AddIcon size={14} strokeWidth={1.75} aria-hidden />
      <span className="flex-1 text-left">New session</span>
      {kbd && <YKbd>{kbd}</YKbd>}
    </button>
  )
}

/** The sidebar's foot: a link to every session, with the count. */
export function YSidebarAll({ count, onClick, label = 'All sessions' }: { count?: number; onClick: () => void; label?: string }): JSX.Element {
  return (
    <div className="px-1.5 pb-2">
      <button type="button" onClick={onClick}
        className="flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-md text-subtle outline-none hover:bg-hover hover:text-text
          focus-visible:outline-2 focus-visible:outline-accent">
        <ChevronIcon size={12} strokeWidth={2} aria-hidden />
        <span className="flex-1 text-left">{label}</span>
        {count !== undefined && <span className="tabular-nums">{count}</span>}
      </button>
    </div>
  )
}

/** The bar over the work area: what is open (`title`, with `sub` such as
 *  its branch in mono) and, on the right, its counts and pane controls.
 *  `leading` comes first (the window controls' clearance, a back button).
 *  The title area drags the desktop app's window. */
export function YTopBar({ leading, title, sub, trailing, className }: {
  leading?: ReactNode
  title?: ReactNode
  sub?: ReactNode
  trailing?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <header className={cn('flex h-bar shrink-0 items-center gap-2 border-b border-line bg-surface px-3', className)}>
      {leading}
      <div className="titlebar-drag flex min-w-0 flex-1 items-baseline gap-2 self-stretch py-3">
        {title !== undefined && <span className="min-w-0 truncate text-base font-semibold text-text">{title}</span>}
        {sub && <span className="min-w-0 truncate font-mono text-sm text-subtle">{sub}</span>}
      </div>
      {trailing && <div className="no-drag flex shrink-0 items-center gap-1">{trailing}</div>}
    </header>
  )
}

export interface YCmdKItem {
  id: string
  title: ReactNode
  /** What the item is matched against; defaults to the title if a string. */
  text?: string
  /** Quiet text on the right: the project, a state word. */
  meta?: ReactNode
  detail?: ReactNode
  kbd?: string
  onSelect: () => void
}

export interface YCmdKGroup {
  label: string
  items: readonly YCmdKItem[]
}

/**
 * The command palette: one field that jumps to a session or project, or
 * runs a command. Results are grouped and filtered by the query; arrows
 * move, Enter opens. It opens from a shortcut rather than a trigger, so on
 * closing it hands focus back to whatever had it (the composer, an editor,
 * a terminal).
 */
export function YCmdK({ open, onOpenChange, groups, placeholder = 'Jump to a session or project, or type a command' }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: readonly YCmdKGroup[]
  placeholder?: string
}): JSX.Element {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const finalFocus = useOpenerFocus(open)
  // A reopened palette starts empty.
  useEffect(() => { if (open) { setQ(''); setActive(0) } }, [open])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return groups
      .map((g) => ({
        ...g,
        items: !needle ? g.items : g.items.filter((i) =>
          (i.text ?? (typeof i.title === 'string' ? i.title : '')).toLowerCase().includes(needle)),
      }))
      .filter((g) => g.items.length > 0)
  }, [groups, q])
  const flat = shown.flatMap((g) => g.items)
  useEffect(() => { setActive((a) => Math.min(a, Math.max(0, flat.length - 1))) }, [flat.length])
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  const run = (item: YCmdKItem | undefined): void => {
    if (!item) return
    item.onSelect()
    onOpenChange(false)
  }
  let index = -1
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="no-drag fixed inset-0 bg-overlay transition-opacity duration-100
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup
          aria-label="Command palette"
          finalFocus={finalFocus}
          className="fixed left-1/2 top-[14vh] flex max-h-[min(560px,72vh)] w-[min(640px,calc(100vw-2rem))] -translate-x-1/2
            flex-col bg-raised text-text shadow-raised outline-none transition duration-100
            data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
        >
          <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-4">
            <SearchIcon size={15} strokeWidth={1.75} aria-hidden className="text-subtle" />
            <input
              autoFocus
              value={q}
              onChange={(e) => { setQ(e.target.value); setActive(0) }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)) }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
                else if (e.key === 'Enter') { e.preventDefault(); run(flat[active]) }
              }}
              placeholder={placeholder}
              aria-label={placeholder}
              role="combobox"
              aria-expanded
              aria-controls="cmdk-results"
              aria-activedescendant={flat[active] ? `cmdk-${flat[active].id}` : undefined}
              className="min-w-0 flex-1 bg-transparent text-base text-text outline-none placeholder:text-subtle"
            />
            <YKbd>esc</YKbd>
          </div>
          <div ref={listRef} id="cmdk-results" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {shown.length === 0 && <p className="px-3 py-6 text-center text-md text-subtle">Nothing matches.</p>}
            {shown.map((g) => (
              <div key={g.label} role="group" aria-label={g.label}>
                <div className="px-2.5 pb-1 pt-2.5 text-sm text-subtle">{g.label}</div>
                {g.items.map((item) => {
                  index += 1
                  const i = index
                  return (
                    <div
                      key={item.id}
                      id={`cmdk-${item.id}`}
                      role="option"
                      aria-selected={i === active}
                      data-active={i === active}
                      onMouseMove={() => setActive(i)}
                      onClick={() => run(item)}
                      className={cn('flex min-h-9 cursor-default items-center gap-3 rounded-xs px-2.5 text-md',
                        i === active ? 'bg-selected text-text' : 'text-text')}
                    >
                      <span className="min-w-0 flex-1 truncate">{item.title}</span>
                      {item.meta && <span className="shrink-0 truncate text-sm text-subtle">{item.meta}</span>}
                      {item.detail && <span className="w-36 shrink-0 truncate text-right text-sm text-subtle">{item.detail}</span>}
                      {item.kbd && <span className="shrink-0 font-mono text-xs text-subtle">{item.kbd}</span>}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
          <div className="flex h-9 shrink-0 items-center gap-4 border-t border-line px-4 text-sm text-subtle">
            <span>↑↓ move</span><span>↵ open</span>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
