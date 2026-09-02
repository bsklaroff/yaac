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
    // Every row gets a button — including the selected one, which is the
    // retry when that server is the one that could not be reached.
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
    // The way out for someone who goes and runs `yaac server start`: this
    // page cannot see that happen, so it must be able to ask again.
    expect(html).toContain('id="retry"')
    // Its own control, not another `.add`: the add form's submit answers
    // that selector, and two buttons behind one selector is how a script
    // driving this page ends up clicking the wrong thing.
    expect(html.match(/class="add"/g) ?? []).toHaveLength(1)
    // The add form is the only way out of this state, so it must be here.
    expect(html).toContain('name="url"')
    expect(html).toContain('name="token"')
    expect(html).toContain('yaac auth token create')
  })

  it('drives the preload bridge the SPA uses, not its own IPC', () => {
    const html = connectPageHtml(STATE)
    expect(html).toContain('window.yaacServer')
    expect(html).toContain('bridge.switchTo({ url:')
    expect(html).toContain('bridge.addRemote(url, token)')
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

/**
 * The page's own script, executed against a real DOM and a stub of the
 * preload bridge. The string assertions above prove the markup; these prove
 * the wiring — which is the half that can silently do nothing.
 */
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
      addRemote: (url: string, token: string) => {
        calls.addRemote.push([url, token])
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
   * Put the page's markup in the document and run its inline script against
   * it. Parsed and executed separately rather than through `document.write`,
   * which replaces the Window jsdom is holding — and with it the bridge the
   * script is supposed to find.
   */
  function render(state: ConnectPageState): void {
    const parsed = new DOMParser().parseFromString(connectPageHtml(state), 'text/html')
    document.body.innerHTML = parsed.body.innerHTML
    const code = parsed.querySelector('script')?.textContent ?? ''
    expect(code).not.toBe('')
    // Running the page's own script IS the subject here — it is what wires
    // the buttons to the bridge, and nothing else executes it.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- see above
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
    // Re-enabled, so a transient failure can be retried from the same page.
    expect(row?.disabled).toBe(false)
  })

  it('a successful Connect leaves "Connecting…" up — the shell relands the window', async () => {
    const calls = mount(STATE, { ok: true })
    document.querySelector<HTMLButtonElement>('button.connect')?.click()
    await settle()
    expect(calls.switchTo).toHaveLength(1)
    expect(document.getElementById('status')?.textContent).toContain('Connecting…')
  })

  it('the add form passes both fields, and refuses an incomplete one itself', async () => {
    const calls = mount(STATE)
    const form = document.getElementById('add') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(calls.addRemote).toHaveLength(0)
    expect(document.getElementById('status')?.textContent).toMatch(/Enter both/)

    document.querySelector<HTMLInputElement>('input[name="url"]')!.value = ' https://new.ts.net '
    document.querySelector<HTMLInputElement>('input[name="token"]')!.value = ' tok '
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(calls.addRemote).toEqual([['https://new.ts.net', 'tok']])
  })

  it('Try again re-runs the flow, which is the only exit from a zero-row picker', async () => {
    // With no rows and no token to type, re-resolving is the ONLY way
    // forward for someone who just started a server in a terminal.
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
