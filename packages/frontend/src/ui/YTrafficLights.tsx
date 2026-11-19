import type { JSX } from 'react'
import { cn } from './cn'
import { hidesTitleBar } from '#lib/platform'

/**
 * Room for the native traffic lights in the macOS desktop app, which hides
 * its title bar and places them 12px from the window's left edge, centred
 * on the 44px top bar's text (`trafficLightPosition` in
 * packages/desktop/src/main.ts). Its default width clears them from the
 * sidebar header's 12px padding; a bar that starts further right narrows
 * it. It drags the window like the rest of the bar. Nothing elsewhere. In
 * full screen macOS hides the lights but the room stays, so the bar does
 * not shift when they come back with the title bar.
 */
export function YTrafficLights({ className }: { className?: string }): JSX.Element | null {
  if (!hidesTitleBar()) return null
  return <div aria-hidden className={cn('titlebar-drag w-16 shrink-0 self-stretch', className)} />
}
