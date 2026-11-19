import type { JSX, ReactNode } from 'react'
import { cn } from './cn'
import { Checkbox } from '@base-ui/react/checkbox'
import { CheckIcon } from '#lib/icons'

/** A checkbox, with its label beside it when `children` are given (the
 *  whole row is then the click target). */
export function YCheckbox({ checked, onCheckedChange, disabled, children, className, ...rest }: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  children?: ReactNode
  className?: string
} & Omit<Checkbox.Root.Props, 'checked' | 'onCheckedChange' | 'disabled' | 'children' | 'className'>): JSX.Element {
  const box = (
    <Checkbox.Root
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next)}
      disabled={disabled}
      {...rest}
      className={cn(
        'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-xs bg-sunken shadow-inset outline-none',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        'data-[checked]:bg-inverse data-[checked]:text-on-inverse data-[disabled]:opacity-50',
        children === undefined && className,
      )}
    >
      <Checkbox.Indicator className="flex"><CheckIcon size={11} strokeWidth={3} aria-hidden /></Checkbox.Indicator>
    </Checkbox.Root>
  )
  if (children === undefined) return box
  return (
    <label className={cn('inline-flex cursor-default select-none items-center gap-2 text-md text-text',
      disabled && 'opacity-50', className)}>
      {box}
      {children}
    </label>
  )
}
