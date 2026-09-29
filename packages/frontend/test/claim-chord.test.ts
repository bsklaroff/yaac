// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { claimChord } from '#lib/shortcuts'

/**
 * macOS dead-key chords: the accent Chrome composes for Option+N arrives
 * after the keydown the command claimed, in whatever field the command
 * focused. jsdom has no input method, so the composition is played by hand:
 * the events Chrome dispatches, with the text it inserts in between.
 */
describe('claimChord', () => {
  let from: HTMLTextAreaElement
  let field: HTMLTextAreaElement
  let seen: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<textarea id="from"></textarea><textarea id="field"></textarea>'
    from = document.getElementById('from') as HTMLTextAreaElement
    field = document.getElementById('field') as HTMLTextAreaElement
    seen = []
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input', 'change']) {
      field.addEventListener(type, () => seen.push(type))
    }
    // As Chrome does when a field is blurred with a value it didn't have on
    // focus — React takes it as an onChange.
    field.addEventListener('blur', () => field.dispatchEvent(new Event('change', { bubbles: true })))
    from.focus()
  })
  afterEach(() => vi.useRealTimers())

  /** A keydown on the focused element, claimed as a command's chord that
   *  moves focus to `field` (as Alt+N does to the prompt). */
  const chord = (key: string): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { key, code: 'KeyN', altKey: true, bubbles: true, cancelable: true })
    const claim = (): void => { claimChord(e); field.focus() }
    window.addEventListener('keydown', claim, { capture: true, once: true })
    ;(document.activeElement ?? document.body).dispatchEvent(e)
    return e
  }
  /** Chrome's composition of `text` into the focused field. */
  const compose = (text: string): void => {
    const el = document.activeElement as HTMLTextAreaElement
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    el.dispatchEvent(new CompositionEvent('compositionupdate', { data: text, bubbles: true }))
    el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end')
    el.dispatchEvent(new InputEvent('input', { data: text, inputType: 'insertCompositionText', bubbles: true }))
  }

  it('discards the accent a dead-key chord leaves in the field it focused, unseen by its handlers', () => {
    field.value = 'keep me'
    field.setSelectionRange(0, 7)
    const e = chord('Dead')
    expect(e.defaultPrevented).toBe(true)
    compose('˜')
    expect(field.value).toBe('˜')
    vi.runAllTimers()
    expect(field.value).toBe('keep me')
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 7])
    expect(document.activeElement).toBe(field)
    expect(seen).toEqual([])

    // Only that one composition: an accent typed in the field afterwards is
    // the user's, and so is one after any chord that wasn't a dead key.
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Dead', bubbles: true }))
    compose('´')
    vi.runAllTimers()
    expect(field.value).toBe('´')
    chord('n')
    compose('˜')
    vi.runAllTimers()
    expect(field.value).toBe('´˜')
    expect(seen).toContain('compositionstart')
  })

  it('stops waiting at the next key event when no accent follows the chord', () => {
    // Nothing editable had focus, so Chrome sent no composition; the chord's
    // release ends the wait, and dictation afterwards (no keydown) lands.
    from.blur()
    chord('Dead')
    field.dispatchEvent(new KeyboardEvent('keyup', { key: 'Dead', code: 'KeyN', bubbles: true }))
    compose('é')
    vi.runAllTimers()
    expect(field.value).toBe('é')

    // So does a keydown: an accent typed after it is the user's.
    chord('Dead')
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }))
    compose('é')
    vi.runAllTimers()
    expect(field.value).toBe('éé')
    expect(seen.filter((t) => t === 'compositionstart')).toHaveLength(2)
  })
})
