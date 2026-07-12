// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderStatus, statusText, type LauncherErrorKind, type LauncherStatus } from '#status'

describe('statusText', () => {
  it('describes progress phases', () => {
    expect(statusText({ phase: 'resolving' }).title).toMatch(/Locating/)
    expect(statusText({ phase: 'starting-server' }).title).toMatch(/Starting/)
    expect(statusText({ phase: 'connecting', baseUrl: 'http://x' }).title).toContain('http://x')
    expect(statusText({ phase: 'navigating', baseUrl: 'http://x' }).title).toContain('http://x')
  })
  it('gives every error kind a title and a recovery hint', () => {
    const kinds: LauncherErrorKind[] = [
      'no-cli', 'server-start-failed', 'no-server', 'unreachable-remote', 'bad-token',
    ]
    for (const kind of kinds) {
      const text = statusText({ phase: 'error', kind })
      expect(text.title).toBeTruthy()
      expect(text.hint).toBeTruthy()
    }
  })
  it('passes error detail through verbatim', () => {
    const status: LauncherStatus = {
      phase: 'error', kind: 'server-start-failed', detail: 'boom <stderr>',
    }
    expect(statusText(status).detail).toBe('boom <stderr>')
  })
})

describe('renderStatus', () => {
  it('renders title, detail, and hint', () => {
    const el = document.createElement('div')
    renderStatus(el, { phase: 'error', kind: 'server-start-failed', detail: 'exit 1' })
    expect(el.querySelector('.title')?.textContent).toMatch(/failed to start/)
    expect(el.querySelector('.detail')?.textContent).toBe('exit 1')
    expect(el.querySelector('.hint')?.textContent).toMatch(/yaac server start/)
  })
  it('omits detail/hint nodes when absent and replaces prior content', () => {
    const el = document.createElement('div')
    renderStatus(el, { phase: 'error', kind: 'no-cli', detail: 'ENOENT' })
    renderStatus(el, { phase: 'resolving' })
    expect(el.querySelectorAll('.title')).toHaveLength(1)
    expect(el.querySelector('.detail')).toBeNull()
    expect(el.querySelector('.hint')).toBeNull()
  })
  it('treats detail as text, not HTML', () => {
    const el = document.createElement('div')
    renderStatus(el, { phase: 'error', kind: 'server-start-failed', detail: '<img src=x>' })
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('.detail')?.textContent).toBe('<img src=x>')
  })
})
