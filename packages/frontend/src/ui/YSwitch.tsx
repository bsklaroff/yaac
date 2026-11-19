import type { JSX } from 'react'
import { cn } from './cn'
import { Switch } from '@base-ui/react/switch'

/** An on/off setting that applies at once. Needs an `aria-label` (or a
 *  surrounding label) saying what it turns on. */
export function YSwitch({ checked, onCheckedChange, disabled, className, ...aria }: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
  'aria-label'?: string
  title?: string
}): JSX.Element {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next)}
      disabled={disabled}
      {...aria}
      className={cn(
        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-xs bg-line-strong p-0.5 outline-none transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        'data-[checked]:bg-inverse data-[disabled]:opacity-50',
        className,
      )}
    >
      <Switch.Thumb className="block h-3 w-3 rounded-[2px] bg-surface shadow-control transition-transform
        data-[checked]:translate-x-3" />
    </Switch.Root>
  )
}
