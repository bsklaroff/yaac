import type { JSX, ReactNode } from 'react'
import { cn } from './cn'
import { Tabs } from '@base-ui/react/tabs'
import type { YIconGlyph } from './types'

/**
 * A row of tabs switching what the region below shows. The active tab sits
 * on the selected fill; there is no underline. Arrow keys move between tabs
 * (base-ui Tabs). The caller renders the content for `value`.
 */
export interface YTab<T extends string> {
  value: T
  label: ReactNode
  icon?: YIconGlyph
}

export function YTabs<T extends string>({ tabs, value, onChange, ariaLabel, className }: {
  tabs: readonly YTab<T>[]
  value: T
  onChange: (value: T) => void
  ariaLabel?: string
  className?: string
}): JSX.Element {
  return (
    <Tabs.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <Tabs.List aria-label={ariaLabel} className={cn('flex shrink-0 items-center gap-1', className)}>
        {tabs.map(({ value: v, label, icon: IconGlyph }) => (
          <Tabs.Tab
            key={v}
            value={v}
            className="inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 text-md
              text-subtle outline-none transition-colors hover:text-text focus-visible:outline-2
              focus-visible:outline-accent data-[active]:bg-selected data-[active]:text-text"
          >
            {IconGlyph && <IconGlyph size={14} strokeWidth={1.75} aria-hidden />}
            {label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs.Root>
  )
}
