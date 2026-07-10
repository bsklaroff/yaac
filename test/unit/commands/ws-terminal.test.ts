import { describe, it, expect } from 'vitest'
import { buildPtyAttachUrl, toWsUrl } from '@/commands/ws-terminal'

describe('toWsUrl', () => {
  it('swaps http(s) for ws(s), preserving the rest', () => {
    expect(toWsUrl('http://127.0.0.1:8787')).toBe('ws://127.0.0.1:8787')
    expect(toWsUrl('https://srv.tailnet.ts.net')).toBe('wss://srv.tailnet.ts.net')
  })
})

describe('buildPtyAttachUrl', () => {
  it('builds the attach URL with id, target, and size', () => {
    const url = new URL(buildPtyAttachUrl('https://srv.ts.net', {
      sessionId: 'abc-123',
      target: 'native',
      cols: 132,
      rows: 43,
    }))
    expect(url.protocol).toBe('wss:')
    expect(url.host).toBe('srv.ts.net')
    expect(url.pathname).toBe('/pty/attach')
    expect(url.searchParams.get('id')).toBe('abc-123')
    expect(url.searchParams.get('target')).toBe('native')
    expect(url.searchParams.get('cols')).toBe('132')
    expect(url.searchParams.get('rows')).toBe('43')
  })

  it('omits size params when the terminal has no dimensions (no TTY)', () => {
    const url = new URL(buildPtyAttachUrl('http://127.0.0.1:8787', {
      sessionId: 'abc',
      target: 'shell',
    }))
    expect(url.searchParams.has('cols')).toBe(false)
    expect(url.searchParams.has('rows')).toBe(false)
  })
})
