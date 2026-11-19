import type { InputHTMLAttributes, JSX, ReactNode, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { cn } from './cn'

/*
 * Text fields and native selects: sunken, with an inset edge and the accent
 * focus ring. Every native prop passes through, `ref` included, so they
 * work controlled, uncontrolled or inside a <form>. `className` adds size
 * and layout. A native <select> keeps the platform picker on phones; the
 * chevron comes from the global `select` rule in index.css. `bare` drops the
 * field look for a field inside a box that draws its own (a find bar beside
 * its toggles, the chat composer).
 */

/** The field look, for a box that wraps its own input (YNumberInput). */
export const FIELD_BOX = 'rounded-sm bg-sunken text-md text-text shadow-inset '
  + 'focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-accent'

const FIELD = 'rounded-sm bg-sunken text-md text-text shadow-inset outline-none placeholder:text-subtle '
  + 'focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent '
  + 'disabled:cursor-not-allowed disabled:opacity-50'

const BARE = 'min-w-0 bg-transparent text-text outline-none placeholder:text-subtle disabled:opacity-50'

export function YInput({ bare = false, className, ref, ...props }: { bare?: boolean; className?: string; ref?: Ref<HTMLInputElement> }
  & Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>): JSX.Element {
  return <input ref={ref} {...props} className={cn(bare ? BARE : [FIELD, 'h-control-sm min-w-0 px-2.5'], className)} />
}

export function YTextArea({ bare = false, className, ref, ...props }: { bare?: boolean; className?: string; ref?: Ref<HTMLTextAreaElement> }
  & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>): JSX.Element {
  return <textarea ref={ref} {...props} className={cn(bare ? BARE : [FIELD, 'min-w-0 px-2.5 py-1.5'], className)} />
}

/** A hidden file picker; open it with `ref.current.click()` from a visible
 *  control. `directory` picks a whole folder. */
export function YFileInput({ directory = false, ref, ...props }: { directory?: boolean; ref?: Ref<HTMLInputElement> }
  & Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'hidden' | 'className'>): JSX.Element {
  return <input ref={ref} type="file" hidden {...props} {...(directory ? { webkitdirectory: '' } : {})} />
}

/** A slider. */
export function YRange({ className, ref, ...props }: { className?: string; ref?: Ref<HTMLInputElement> }
  & Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'>): JSX.Element {
  return (
    <input
      ref={ref}
      type="range"
      {...props}
      className={cn('h-1 min-w-0 cursor-pointer accent-[var(--text)] outline-none focus-visible:outline-2',
        'focus-visible:outline-accent', className)}
    />
  )
}

export function YSelect({ className, ref, children, ...props }: {
  className?: string
  ref?: Ref<HTMLSelectElement>
  children: ReactNode
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'children'>): JSX.Element {
  return (
    <select ref={ref} {...props} className={cn(FIELD, 'h-control-sm min-w-0 cursor-default pl-2.5', className)}>
      {children}
    </select>
  )
}
