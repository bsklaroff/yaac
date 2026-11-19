import type { ButtonHTMLAttributes, JSX, ReactNode, Ref } from 'react'
import { cn } from './cn'
import type { YIconGlyph } from './types'
import { YKbd } from './YKbd'

/**
 * The one button. `primary` is graphite, one per view; `secondary` is the
 * raised default; `ghost` is text until hovered; `danger` is a ghost in red;
 * `link` is an inline text link. `bare` keeps only the focus ring and the
 * disabled state, for a clickable region that is not a button in look (a
 * list row, a thumbnail, a terminal key): its classes come from the caller,
 * and it takes no size.
 * With an `icon` and no children it is a square icon button, which needs an
 * `aria-label`. `kbd` shows the shortcut inside the button.
 *
 * Every prop a <button> takes passes through, including `ref`, so base-ui
 * triggers can render it (`<Menu.Trigger render={<YButton … />} />`).
 */
export type YButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link' | 'bare'

const VARIANT: Record<YButtonVariant, string> = {
  primary: 'surface-primary shadow-primary text-on-primary hover:surface-primary-hover active:shadow-pressed',
  secondary: 'surface-control shadow-control text-text hover:surface-control-hover '
    + 'active:surface-pressed active:shadow-pressed data-[popup-open]:surface-pressed data-[popup-open]:shadow-pressed',
  ghost: 'text-muted hover:bg-hover hover:text-text active:bg-selected data-[popup-open]:bg-selected '
    + 'data-[popup-open]:text-text',
  danger: 'text-danger hover:bg-danger-soft active:bg-danger-soft',
  link: 'text-info underline-offset-2 hover:underline',
  bare: '',
}

export const BUTTON_BASE = 'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap '
  + 'rounded-sm font-medium outline-none transition-[background,box-shadow,color] duration-100 '
  + 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent '
  + 'disabled:cursor-default disabled:opacity-50'

/** The classes a YButton gets, for the rare element that must look like one
 *  but cannot be one (a label wrapping a file input). */
export function yButtonClass(variant: YButtonVariant = 'secondary', size: YButtonSize = 'md', iconOnly = false): string {
  if (variant === 'bare' || variant === 'link') return cn(BARE_BASE, VARIANT[variant])
  return cn(BUTTON_BASE, VARIANT[variant], SIZE[size], iconOnly ? SQUARE[size] : PAD[size])
}

/* What every button has, sized or not: the focus ring and the disabled
 * state. */
const BARE_BASE = 'outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent '
  + 'disabled:cursor-default disabled:opacity-50'

/** `xs` (20px) for dense strips, `sm` (24px) for toolbars and rows, `md`
 *  (28px) by default, `lg` (36px) for touch targets on phones. */
export type YButtonSize = 'xs' | 'sm' | 'md' | 'lg'
const SIZE: Record<YButtonSize, string> = { xs: 'h-5 text-xs', sm: 'h-6 text-sm', md: 'h-control-sm text-sm', lg: 'h-9 text-base' }
const SQUARE: Record<YButtonSize, string> = { xs: 'w-5', sm: 'w-6', md: 'w-control-sm', lg: 'w-9' }
const PAD: Record<YButtonSize, string> = { xs: 'px-1.5', sm: 'px-2', md: 'px-2.5', lg: 'px-3' }
const ICON: Record<YButtonSize, number> = { xs: 11, sm: 12, md: 14, lg: 16 }

export function YButton({ variant = 'secondary', size = 'md', icon: IconGlyph, kbd, className, children, type = 'button', ref, ...props }: {
  variant?: YButtonVariant
  size?: YButtonSize
  icon?: YIconGlyph
  kbd?: string
  className?: string
  children?: ReactNode
  ref?: Ref<HTMLButtonElement>
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>): JSX.Element {
  const iconOnly = IconGlyph !== undefined && (children === undefined || children === null || children === false)
  return (
    <button ref={ref} type={type} {...props} className={cn(yButtonClass(variant, size, iconOnly), className)}>
      {IconGlyph && <IconGlyph size={ICON[size]} strokeWidth={1.75} aria-hidden />}
      {children}
      {kbd && <YKbd className="ml-0.5">{kbd}</YKbd>}
    </button>
  )
}
