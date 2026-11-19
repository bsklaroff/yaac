import type { ButtonHTMLAttributes, JSX, ReactNode, Ref } from 'react'
import { cn } from './cn'
import { DropdownIcon } from '#lib/icons'
import type { YIconGlyph } from './types'

/**
 * A compact setting you can change in place: the composer's mode, model and
 * effort, a pane's diff mode. Text until hovered; `selected` raises it like
 * a pressed key. `dropdown` adds the chevron when it opens a menu. Pass-through
 * props and `ref` let base-ui triggers render it.
 */
export function YChip({ icon: IconGlyph, dropdown = false, selected = false, className, children, type = 'button', ref, ...props }: {
  icon?: YIconGlyph
  dropdown?: boolean
  selected?: boolean
  className?: string
  children?: ReactNode
  ref?: Ref<HTMLButtonElement>
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>): JSX.Element {
  return (
    <button
      ref={ref}
      type={type}
      {...props}
      className={cn(
        'inline-flex h-[26px] min-w-0 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm px-2 text-sm font-medium',
        'outline-none transition-[background,box-shadow,color] duration-100 focus-visible:outline-2',
        'focus-visible:outline-accent disabled:cursor-default disabled:opacity-50',
        selected
          ? 'surface-control text-text shadow-control'
          : 'text-muted hover:bg-hover hover:text-text data-[popup-open]:bg-selected data-[popup-open]:text-text',
        className,
      )}
    >
      {IconGlyph && <IconGlyph size={13} strokeWidth={1.75} aria-hidden />}
      {children}
      {dropdown && <DropdownIcon size={11} strokeWidth={2} aria-hidden className="text-subtle" />}
    </button>
  )
}
