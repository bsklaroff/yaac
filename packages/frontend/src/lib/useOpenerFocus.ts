import { useRef } from 'react'

/**
 * A controlled dialog's `finalFocus`: back to whatever held focus when it
 * opened, or nowhere if nothing did.
 *
 * Base UI's default, for a dialog with no trigger, is the last element any
 * popup was opened from. A row's `…` menu blurs before a pointer pick opens
 * a dialog, and that default would then pick the menu's hover-only trigger,
 * pinning it visible on a row the pointer has left. An opener that has since
 * left the page (a menu item, a stopped row) still gets that default, which
 * is then the right answer: the popup it came from.
 */
export function useOpenerFocus(open: boolean): () => HTMLElement | boolean {
  const opener = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)
  // Read during render, before the popup mounts and moves focus into itself.
  if (open && !wasOpen.current) {
    const active = document.activeElement
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null
  }
  wasOpen.current = open
  return () => opener.current === null ? false : opener.current.isConnected ? opener.current : true
}
