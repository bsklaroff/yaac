/**
 * The main-process half of a hidden preview's lifecycle: freezing a
 * `<webview>` guest's page and saying whether it may be discarded. The
 * preview pane decides when (docs/preview-lifecycle.md); this module owns
 * what only the guest's webContents can see or do.
 */

/** The part of a webview guest's WebContents this module uses. */
export interface PreviewGuest {
  isCurrentlyAudible(): boolean
  isDevToolsOpened(): boolean
  on(event: 'before-input-event', listener: (e: unknown, input: { type: string; control: boolean; meta: boolean }) => void): unknown
  on(event: 'did-navigate', listener: () => void): unknown
  debugger: {
    isAttached(): boolean
    attach(protocolVersion?: string): void
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  }
}

/** Guests the user typed into since their page last loaded. */
const edited = new WeakSet<PreviewGuest>()

/**
 * Watch a guest for typing. Chrome never proactively discards a page with
 * form input or user edits, since a reload loses them; a keystroke is this
 * app's stand-in for that signal, cleared when the page navigates.
 */
export function trackPreviewGuest(guest: PreviewGuest): void {
  guest.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && !input.control && !input.meta) edited.add(guest)
  })
  guest.on('did-navigate', () => edited.delete(guest))
}

/**
 * Freeze or thaw a guest's page through the DevTools protocol, the same
 * lifecycle state Chrome puts a frozen background tab in. A page playing
 * audio or open in DevTools is not frozen. Resolves whether the request
 * took effect. The command is sent before any await, so a thaw that
 * follows a freeze always reaches the page after it.
 */
export async function setPreviewFrozen(guest: PreviewGuest, frozen: boolean): Promise<boolean> {
  if (frozen && (guest.isCurrentlyAudible() || guest.isDevToolsOpened())) return false
  if (!guest.debugger.isAttached()) {
    if (!frozen) return true
    try {
      guest.debugger.attach('1.3')
    } catch {
      return false
    }
  }
  try {
    await guest.debugger.sendCommand('Page.setWebLifecycleState', { state: frozen ? 'frozen' : 'active' })
    return true
  } catch {
    return false
  }
}

/**
 * Whether a hidden guest may be discarded, by Chrome's proactive-discard
 * protections that apply to a preview: not playing audio, no DevTools open
 * on it (they would not come back), and nothing typed into the page.
 */
export function canDiscardPreview(guest: PreviewGuest): boolean {
  return !guest.isCurrentlyAudible() && !guest.isDevToolsOpened() && !edited.has(guest)
}
