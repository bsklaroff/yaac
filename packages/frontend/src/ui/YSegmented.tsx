import type { JSX, ReactNode } from 'react'
import { cn } from './cn'
import { ToggleGroup } from '@base-ui/react/toggle-group'
import { Toggle } from '@base-ui/react/toggle'
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import type { YIconGlyph } from './types'

/**
 * Pick one of a few options in place: Desktop / Phone, Dark / Light / Auto.
 * The chosen option is raised like a pressed key. Arrow keys move between
 * options (base-ui ToggleGroup); choosing the current one again keeps it.
 */
export interface YSegmentedOption<T extends string> {
  value: T
  label: ReactNode
  icon?: YIconGlyph
  /** For an option shown by its icon alone. */
  ariaLabel?: string
  title?: string
  disabled?: boolean
}

export function YSegmented<T extends string>({ options, value, onChange, size = 'md', className, ariaLabel }: {
  options: readonly YSegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  className?: string
  ariaLabel?: string
}): JSX.Element {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(next) => { const v = next[0] as T | undefined; if (v !== undefined) onChange(v) }}
      aria-label={ariaLabel}
      className={cn('inline-flex shrink-0 gap-0.5', className)}
    >
      {options.map(({ value: v, label, icon: IconGlyph, ariaLabel: optionLabel, title, disabled }) => (
        <Toggle
          key={v}
          value={v}
          disabled={disabled}
          aria-label={optionLabel}
          title={title}
          className={cn(
            'inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 font-medium outline-none',
            'transition-[background,box-shadow,color] duration-100 focus-visible:outline-2 focus-visible:outline-accent',
            'disabled:cursor-default disabled:opacity-50',
            size === 'sm' ? 'h-6 text-xs' : 'h-[26px] text-sm',
            'text-muted hover:text-text data-[pressed]:surface-control data-[pressed]:text-text data-[pressed]:shadow-control',
          )}
        >
          {IconGlyph && <IconGlyph size={13} strokeWidth={1.75} aria-hidden />}
          {label}
        </Toggle>
      ))}
    </ToggleGroup>
  )
}

/**
 * A grid of equal options read as one radio group (an effort level), for a
 * picker inside a popup. At most four to a row, so a name like "Minimal"
 * fits at phone width, with the rows balanced (six as 3 + 3, nine as 3 × 3)
 * rather than leaving one option alone on the last. Arrow keys move the
 * choice (base-ui RadioGroup).
 */
export function YRadioGrid<T extends string>({ options, value, onChange, ariaLabel, className }: {
  options: readonly { value: T; label: ReactNode }[]
  value: T | undefined
  onChange: (value: T) => void
  ariaLabel: string
  className?: string
}): JSX.Element {
  const rows = Math.ceil(options.length / 4)
  return (
    <RadioGroup
      aria-label={ariaLabel}
      value={value}
      onValueChange={(v: T) => onChange(v)}
      className={cn('grid rounded-sm bg-sunken p-0.5', className)}
      style={{ gridTemplateColumns: `repeat(${String(Math.ceil(options.length / rows))}, minmax(0, 1fr))` }}
    >
      {options.map((o) => (
        <Radio.Root
          key={o.value}
          value={o.value}
          className="cursor-default truncate rounded-xs px-1 py-1 text-center text-md text-muted outline-none
            hover:bg-line-strong hover:text-text focus-visible:outline-1 focus-visible:outline-accent
            data-[checked]:bg-line-strong data-[checked]:text-text"
        >
          {o.label}
        </Radio.Root>
      ))}
    </RadioGroup>
  )
}
