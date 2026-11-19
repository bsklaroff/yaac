import clsx, { type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/*
 * Class names for a component that also takes a `className`: later classes
 * win over the component's own when they set the same thing (`h-9` over
 * `h-control-sm`, `text-danger` over `text-muted`). Tailwind alone would
 * pick by the order it emits the utilities, not the order they are written.
 * The merge is told this app's own scale names (styles/tokens.css).
 */
const merge = extendTailwindMerge<'surface'>({
  extend: {
    theme: {
      text: ['xs', 'sm', 'md', 'base', 'lg', 'xl'],
      spacing: ['bar', 'control-xs', 'control-sm', 'control-md', 'control-lg'],
      shadow: ['control', 'primary', 'pressed', 'inset', 'raised'],
    },
    classGroups: {
      surface: [{ surface: ['control', 'control-hover', 'pressed', 'primary', 'primary-hover'] }],
    },
  },
})

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs))
}
