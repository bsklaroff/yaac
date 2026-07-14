import { describe, expect, it } from 'vitest'
import { errorBoxText, splashHtml, splashUrl } from '#messages'

describe('splashHtml', () => {
  it('embeds the status text', () => {
    expect(splashHtml('Starting the local yaac server…')).toContain('Starting the local yaac server…')
  })
  it('escapes HTML in the status', () => {
    const html = splashHtml('<img src=x> & "quotes"')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x&gt; &amp; &quot;quotes&quot;')
  })
})

describe('splashUrl', () => {
  it('produces a data: URL wrapping the html', () => {
    const url = splashUrl('Connecting…')
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true)
    expect(decodeURIComponent(url.slice(url.indexOf(',') + 1))).toContain('Connecting…')
  })
})

describe('errorBoxText', () => {
  it('joins detail and hint with a blank line', () => {
    expect(errorBoxText({ title: 't', detail: 'exit 1', hint: 'relaunch' })).toBe('exit 1\n\nrelaunch')
  })
  it('omits absent parts', () => {
    expect(errorBoxText({ title: 't', hint: 'relaunch' })).toBe('relaunch')
    expect(errorBoxText({ title: 't' })).toBe('')
  })
})
