import type { JSX } from 'react'
import { cn } from './cn'
import { identityFamily, identityInitial } from './identity'

/** A person as their initial on their colour family's fill. */
export function YAvatar({ id, name, size = 24, className }: {
  id: string
  name: string
  size?: number
  className?: string
}): JSX.Element {
  const family = identityFamily(id)
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold leading-none', className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.45),
        background: `var(--proj-${family}-fill)`,
        color: 'var(--proj-on)',
      }}
    >
      {identityInitial(name)}
    </span>
  )
}
