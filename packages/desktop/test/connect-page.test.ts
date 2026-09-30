// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { connectPageHtml, connectPageUrl, type ConnectPageState } from '#connect-page'

const STATE: ConnectPageState = {
  error: {
    title: 'Could not connect to http://127.0.0.1:8787',
    detail: 'cannot reach the yaac server at http://127.0.0.1:8787 (fetch failed)',
    hint: 'Check that the server is running, then connect again.',
  },
  targets: {
    current: 'http://127.0.0.1:8787',
    saved: ['http://127.0.0.1:8787', 'https://b.ts.net'],
  },
}

describe('connectPageHtml', () => {
  it('states the failure: title, verbatim detail, and hint', () => {
    const html = connectPageHtml(STATE)
    expect(html).toContain('Could not connect to http://127.0.0.1:8787')
    expect(html).toContain('cannot reach the yaac server at http://127.0.0.1:8787 (fetch failed)')
    expect(html).toContain('Check that the server is running, then connect again.')
  })

  it('offers one Connect row per saved server, marking the selected one', () => {
    const html = connectPageHtml(STATE)
    // The selected row gets a button too: it is the retry.
    expect(html.match(/class="connect" data-url=/g)).toHaveLength(2)
    expect(html).toContain('data-url="http://127.0.0.1:8787"')
    expect(html).toContain('data-url="https://b.ts.net"')
    expect(html).toContain('selected')
  })

  it('has no local-server row — a server here is named by its origin', () => {
    expect(connectPageHtml(STATE)).not.toContain('Local server')
  })

  it('says so, and still takes a new server, when nothing is configured', () => {
    const html = connectPageHtml({
      error: { title: 'No yaac server selected' },
      targets: { current: null, saved: [] },
    })
    expect(html).toContain('No servers configured yet.')
    expect(html).not.toContain('class="connect"')
    expect(html).toContain('id="retry"')
    // Retry has its own id so `.add` matches only the form's submit button.
    expect(html.match(/class="add"/g) ?? []).toHaveLength(1)
    expect(html).toContain('name="url"')
    expect(html).not.toContain('name="token"')
  })

  it('drives the preload bridge the SPA uses, not its own IPC', () => {
    const html = connectPageHtml(STATE)
    expect(html).toContain('window.yaacServer')
    expect(html).toContain('bridge.switchTo({ url:')
    expect(html).toContain('bridge.addRemote(url)')
    // The native traffic lights are hidden, so the page provides its own.
    expect(html).toContain('window.yaacWindow.close()')
    expect(html).toContain('-webkit-app-region: drag')
  })

  it('escapes server-supplied text rather than letting it close a tag', () => {
    const html = connectPageHtml({
      error: { title: 'x', detail: '<img src=x onerror="alert(1)">' },
      targets: { current: null, saved: ['https://evil"><script>alert(1)</script>'] },
    })
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;img src=x')
  })
})

describe('connectPageUrl', () => {
  it('is a data: URL whose decoded body is the page', () => {
    const url = connectPageUrl(STATE)
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true)
    const decoded = decodeURIComponent(url.slice('data:text/html;charset=utf-8,'.length))
    expect(decoded).toBe(connectPageHtml(STATE))
  })
})

/** The page's inline script, run against jsdom and a stub preload bridge. */
describe('connectPageHtml (running in a document)', () => {
  interface Calls { switchTo: unknown[]; addRemote: unknown[][]; closed: number; retried: number }

  function mount(state: ConnectPageState, outcome: unknown = { ok: false, error: 'cannot reach it' }) {
    const calls: Calls = { switchTo: [], addRemote: [], closed: 0, retried: 0 }
    const w = window as unknown as Record<string, unknown>
    w.yaacServer = {
      switchTo: (sel: unknown) => {
        calls.switchTo.push(sel)
        return Promise.resolve(outcome)
      },
      addRemote: (url: string) => {
        calls.addRemote.push([url])
        return Promise.resolve(outcome)
      },
      retry: () => {
        calls.retried += 1
        return Promise.resolve({ ok: true })
      },
    }
    w.yaacWindow = { close: () => { calls.closed += 1 } }
    render(state)
    return calls
  }

  /**
   * Put the page's markup in the document and run its inline script. Not
   * `document.write`, which would replace the window holding the stub bridge.
   */
  function render(state: ConnectPageState): void {
    const parsed = new DOMParser().parseFromString(connectPageHtml(state), 'text/html')
    document.body.innerHTML = parsed.body.innerHTML
    const code = parsed.querySelector('script')?.textContent ?? ''
    expect(code).not.toBe('')
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- running the page's inline script is the subject under test
    new Function(code)()
  }

  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('Connect sends the row\'s origin and surfaces a refusal without leaving the page', async () => {
    const calls = mount(STATE)
    const row = document.querySelector<HTMLButtonElement>('button.connect[data-url="https://b.ts.net"]')
    expect(row).not.toBeNull()
    row?.click()
    await settle()
    expect(calls.switchTo).toEqual([{ url: 'https://b.ts.net' }])
    expect(document.getElementById('status')?.textContent).toContain('cannot reach it')
    expect(row?.disabled).toBe(false)
  })

  it('a successful Connect leaves "Connecting…" up — the shell relands the window', async () => {
    const calls = mount(STATE, { ok: true })
    document.querySelector<HTMLButtonElement>('button.connect')?.click()
    await settle()
    expect(calls.switchTo).toHaveLength(1)
    expect(document.getElementById('status')?.textContent).toContain('Connecting…')
  })

  it('the add form passes the origin, and refuses an empty one itself', async () => {
    const calls = mount(STATE)
    const form = document.getElementById('add') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(calls.addRemote).toHaveLength(0)
    expect(document.getElementById('status')?.textContent).toMatch(/Enter a server origin/)

    document.querySelector<HTMLInputElement>('input[name="url"]')!.value = ' https://new.ts.net '
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(calls.addRemote).toEqual([['https://new.ts.net']])
  })

  it('Try again re-runs the flow, which is the only exit from a zero-row picker', async () => {
    const calls = mount({
      error: { title: 'No yaac server selected' },
      targets: { current: null, saved: [] },
    })
    document.getElementById('retry')?.click()
    await settle()
    expect(calls.retried).toBe(1)
    expect(document.getElementById('status')?.textContent).toContain('Connecting…')
  })

  it('the close button drives the window bridge (the traffic lights are hidden)', () => {
    const calls = mount(STATE)
    document.getElementById('close')?.click()
    expect(calls.closed).toBe(1)
  })

  it('says so, and disables the buttons, when no bridge is present', () => {
    const w = window as unknown as Record<string, unknown>
    delete w.yaacServer
    delete w.yaacWindow
    render(STATE)
    expect(document.getElementById('status')?.textContent).toMatch(/unavailable/)
    expect(document.querySelector<HTMLButtonElement>('button.connect')?.disabled).toBe(true)
  })

  it('renders a hostile origin as text, never as markup', () => {
    mount({
      error: { title: 'x' },
      targets: { current: null, saved: ['https://evil"><img src=x onerror=alert(1)>'] },
    })
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('.origin')?.textContent)
      .toBe('https://evil"><img src=x onerror=alert(1)>')
  })
})
