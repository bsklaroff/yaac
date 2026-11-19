import type { JSX, ReactNode } from 'react'
import { cn } from './cn'

/** A key or chord, drawn as an inset key cap. */
export function YKbd({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <kbd className={cn('inline-flex h-[18px] shrink-0 items-center rounded-xs px-[5px] font-sans text-xs '
      + 'font-normal text-subtle shadow-inset', className)}>
      {children}
    </kbd>
  )
}
