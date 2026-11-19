import type { ComponentType } from 'react'

/** An icon a component draws: any lucide icon from #lib/icons, or another
 *  component taking the same props. */
export type YIconGlyph = ComponentType<{ size?: number; strokeWidth?: number; className?: string; 'aria-hidden'?: boolean }>
