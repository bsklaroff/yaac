import { useRef } from 'react'

/**
 * A controlled dialog's `finalFocus`: return focus to whatever held it when
 * the dialog opened, or to nothing if nothing did.
 *
 * Base UI's default for a dialog without a trigger is the last element any
 * popup opened from. When a row's `…` menu opens a dialog, that would focus
 * the menu's hover-only trigger and leave it visible after the pointer
 * leaves. If the opener has since left the page (a menu item, a stopped
 * row), Base UI's default is used, which is then correct.
 */
export function useOpenerFocus(open: boolean): () => HTMLElement | boolean {
  const opener = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)
  // Read during render, before the popup mounts and takes focus.
  if (open && !wasOpen.current) {
    const active = document.activeElement
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null
  }
  wasOpen.current = open
  return () => opener.current === null ? false : opener.current.isConnected ? opener.current : true
}
