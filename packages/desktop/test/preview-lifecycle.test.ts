import { describe, it, expect, vi } from 'vitest'
import { canDiscardPreview, setPreviewFrozen, trackPreviewGuest, type PreviewGuest } from '#preview-lifecycle'

/** A webview guest whose events a test fires and whose debugger it reads. */
function fakeGuest() {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  let attached = false
  const attach = vi.fn(() => { attached = true })
  const sendCommand = vi.fn(() => Promise.resolve({}))
  const guest = {
    attach,
    sendCommand,
    audible: false,
    devTools: false,
    isCurrentlyAudible: () => guest.audible,
    isDevToolsOpened: () => guest.devTools,
    on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener) },
    debugger: {
      isAttached: () => attached,
      attach,
      sendCommand,
    },
    fire: (event: string, ...args: unknown[]) => listeners.get(event)?.(...args),
  }
  return guest as typeof guest & PreviewGuest
}

describe('setPreviewFrozen', () => {
  it('freezes and thaws the page over the DevTools protocol', async () => {
    const guest = fakeGuest()
    // A thaw before any freeze has nothing to undo.
    expect(await setPreviewFrozen(guest, false)).toBe(true)
    expect(guest.attach).not.toHaveBeenCalled()

    expect(await setPreviewFrozen(guest, true)).toBe(true)
    expect(await setPreviewFrozen(guest, false)).toBe(true)
    expect(guest.attach).toHaveBeenCalledTimes(1)
    expect(guest.sendCommand.mock.calls).toEqual([
      ['Page.setWebLifecycleState', { state: 'frozen' }],
      ['Page.setWebLifecycleState', { state: 'active' }],
    ])
  })

  it('leaves a page playing audio or open in DevTools running', async () => {
    const guest = fakeGuest()
    guest.audible = true
    expect(await setPreviewFrozen(guest, true)).toBe(false)
    guest.audible = false
    guest.devTools = true
    expect(await setPreviewFrozen(guest, true)).toBe(false)
    expect(guest.sendCommand).not.toHaveBeenCalled()
  })
})

describe('canDiscardPreview', () => {
  it('protects a page that is audible, inspected, or typed into until it navigates', () => {
    const guest = fakeGuest()
    trackPreviewGuest(guest)
    expect(canDiscardPreview(guest)).toBe(true)

    guest.audible = true
    expect(canDiscardPreview(guest)).toBe(false)
    guest.audible = false
    guest.devTools = true
    expect(canDiscardPreview(guest)).toBe(false)
    guest.devTools = false

    // A shortcut is not an edit; a keystroke is, until the next page.
    guest.fire('before-input-event', {}, { type: 'keyDown', control: false, meta: true })
    expect(canDiscardPreview(guest)).toBe(true)
    guest.fire('before-input-event', {}, { type: 'keyDown', control: false, meta: false })
    expect(canDiscardPreview(guest)).toBe(false)
    guest.fire('did-navigate')
    expect(canDiscardPreview(guest)).toBe(true)
  })
})
