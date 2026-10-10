// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { DesktopLocalState, DesktopSetupRun } from '@yaac/shared/types'
import { connectPageHtml, connectPageUrl, type ConnectPageState } from '#connect-page'
import { localView } from '#local-setup'
import type { LocalServers, LocalServerState } from '#server-control'

/** No install: what `yaac server|cluster status --json` reports before one exists. */
const NONE = {
  kind: 'status',
  status: { running: false, driver: null, serverBuildId: null, cliBuildId: 'b1' },
} satisfies LocalServerState
const STOPPED: LocalServerState = { kind: 'status', status: { ...NONE.status, driver: 'containerless' } }
const CLUSTER_STOPPED: LocalServerState = { kind: 'status', status: { ...NONE.status, driver: 'k8s' } }
const NO_CLI: LocalServers = { server: { kind: 'no-cli' }, cluster: { kind: 'no-cli' } }

function view(local: LocalServers, more: Partial<Parameters<typeof localView>[0]> = {}): DesktopLocalState {
  return localView({ local, busy: null, setup: null, brew: true, clusterSupported: true, ...more })
}

const NOTHING_READ = view({ server: null, cluster: null })
/** A stopped host server, and no cluster install. */
const HOST_STOPPED = view({ server: STOPPED, cluster: NONE })

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
  local: NOTHING_READ,
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
      local: NOTHING_READ,
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
      local: NOTHING_READ,
    })
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;img src=x')
  })

  it('offers to start each of this machine\'s servers that is stopped', () => {
    const stopped = connectPageHtml({ ...STATE, local: HOST_STOPPED })
    expect(stopped).toContain('data-scope="server">Start a server on this Mac')
    expect(stopped).toContain('each in its own checkout')
    expect(stopped).not.toContain('data-scope="cluster"')
    // A scaled-down cluster install starts back up as pods, beside the host server.
    const both = connectPageHtml({ ...STATE, local: view({ server: STOPPED, cluster: CLUSTER_STOPPED }) })
    expect(both).toContain('data-scope="server"')
    expect(both).toContain('data-scope="cluster">Start this Mac\'s cluster server')
    expect(both).toContain('kind cluster')
    // A ~/.yaac that is itself the cluster install offers only the cluster.
    const legacy = connectPageHtml({ ...STATE, local: view({ server: CLUSTER_STOPPED, cluster: CLUSTER_STOPPED }) })
    expect(legacy).not.toContain('data-scope="server"')
    expect(legacy).toContain('data-scope="cluster"')
    const running: LocalServerState = { kind: 'status', status: { ...NONE.status, driver: 'containerless', running: true } }
    for (const server of [running, null, { kind: 'error', message: 'x' } as const]) {
      expect(connectPageHtml({ ...STATE, local: view({ server, cluster: NONE }) })).not.toContain('class="start"')
    }
  })

  it('leads with both setups when there is no CLI, or no install and no server selected', () => {
    const unselected = { ...STATE, targets: { current: null, saved: [] } }
    for (const state of [{ ...STATE, local: view(NO_CLI) }, { ...unselected, local: view({ server: NONE, cluster: NONE }) }]) {
      const html = connectPageHtml(state)
      expect(html).toContain('Pick where workspaces run')
      expect(html).toContain('This Mac (containerless)')
      expect(html).toContain('the permission mode defaults to accept-edits')
      expect(html).toContain('Local Kubernetes cluster (kind)')
      expect(html).toContain('gVisor-sandboxed pod')
      expect(html).toContain([
        'brew trust bsklaroff/yaac', 'brew install bsklaroff/yaac/yaac-server', 'yaac server start', 'yaac host check',
      ].join('\n'))
      expect(html).toContain([
        'brew trust bsklaroff/yaac', 'brew install bsklaroff/yaac/yaac-server', 'brew trust libkrun/krun',
        'brew tap libkrun/krun', 'brew install bsklaroff/yaac/yaac-cluster', 'yaac cluster install',
      ].join('\n'))
      expect(html).toContain('<button class="setup" data-scope="server">')
      expect(html).toContain('<button class="setup" data-scope="cluster">')
      expect(html).not.toContain('class="start"')
    }
    // With no saved server either, it is a welcome rather than an error.
    const welcome = connectPageHtml({ ...unselected, local: view(NO_CLI) })
    expect(welcome).toContain('<h1>Set up yaac</h1>')
    expect(welcome).not.toContain('Could not connect')
    expect(welcome).not.toContain('<h2>Servers</h2>')
    expect(welcome).toContain('id="add"')
    expect(connectPageHtml({ ...STATE, local: view(NO_CLI) })).toContain('Could not connect to http://127.0.0.1:8787')
    // A selected server that is down is not a fresh Mac: no setup.
    expect(connectPageHtml({ ...STATE, local: view({ server: NONE, cluster: NONE }) })).not.toContain('class="setup"')
    // A Mac with one install is not a fresh Mac either.
    expect(connectPageHtml({ ...unselected, local: view({ server: STOPPED, cluster: NONE }) })).not.toContain('class="setup"')
  })

  it('says what a setup lacks, and turns its button off', () => {
    const html = connectPageHtml({ ...STATE, local: view(NO_CLI, { brew: false, clusterSupported: false }) })
    expect(html).toContain('<button class="setup" data-scope="server" disabled data-blocked>')
    expect(html).toContain('Homebrew is not installed')
    expect(html).toContain('href="https://brew.sh"')
    expect(html).toContain('<button class="setup" data-scope="cluster" disabled data-blocked>')
    expect(html).toContain('it needs macOS on Apple silicon')
    // With the CLI there, the containerless setup needs no Homebrew.
    const cli = connectPageHtml({ ...STATE, targets: { current: null, saved: [] }, local: view({ server: NONE, cluster: NONE }, { brew: false }) })
    expect(cli).toContain('<button class="setup" data-scope="server">')
    expect(cli).toContain('<button class="setup" data-scope="cluster" disabled data-blocked>')
  })

  it('shows one setup alone when the tray asks for it, with a way back', () => {
    const html = connectPageHtml({
      error: { title: 'Set up yaac on this Mac' }, targets: STATE.targets, local: HOST_STOPPED, setup: 'cluster',
    })
    expect(html).toContain('id="choice-cluster"')
    expect(html).not.toContain('id="choice-server"')
    expect(html).toContain('>Back</button>')
    expect(html).not.toContain('id="add"')
    expect(html).not.toContain('class="connect"')
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
  interface Calls {
    switchTo: unknown[]; addRemote: unknown[][]; closed: number; retried: number; started: unknown[]
    setups: unknown[]; cancels: number
  }

  /** What the bridge's `localState` answers, which a test changes as a setup moves on. */
  let polled: DesktopLocalState = NOTHING_READ

  function mount(state: ConnectPageState, outcome: unknown = { ok: false, error: 'cannot reach it' }) {
    polled = state.local
    const calls: Calls = { switchTo: [], addRemote: [], closed: 0, retried: 0, started: [], setups: [], cancels: 0 }
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
      startLocal: (scope: unknown) => {
        calls.started.push(scope)
        return Promise.resolve(outcome)
      },
      localState: () => Promise.resolve(polled),
      setupLocal: (scope: unknown) => {
        calls.setups.push(scope)
        return Promise.resolve(outcome)
      },
      cancelSetup: () => {
        calls.cancels += 1
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
      local: NOTHING_READ,
    })
    document.getElementById('retry')?.click()
    await settle()
    expect(calls.retried).toBe(1)
    expect(document.getElementById('status')?.textContent).toContain('Connecting…')
  })

  it('each start button starts its server, and shows a refusal inline', async () => {
    const calls = mount({ ...STATE, local: view({ server: STOPPED, cluster: CLUSTER_STOPPED }) }, { ok: false, error: 'no Deployment yet' })
    const start = document.querySelector<HTMLButtonElement>('button.start[data-scope="cluster"]')!
    start.click()
    expect(document.getElementById('status')?.textContent).toContain('Starting the server…')
    await settle()
    expect(calls.started).toEqual(['cluster'])
    expect(document.getElementById('status')?.textContent).toContain('no Deployment yet')
    expect(start.disabled).toBe(false)
    document.querySelector<HTMLButtonElement>('button.start[data-scope="server"]')!.click()
    expect(calls.started).toEqual(['cluster', 'server'])
  })

  it('runs a setup, follows its steps and output, and cancels it', async () => {
    const fresh = view(NO_CLI)
    const calls = mount({ ...STATE, local: fresh }, { ok: true })
    const runEl = document.getElementById('run')!
    expect(runEl.hidden).toBe(true)

    const run: DesktopSetupRun = {
      scope: 'cluster',
      phase: 'running',
      steps: [
        { label: 'Trust the yaac tap', command: 'brew trust bsklaroff/yaac', state: 'skipped', note: 'already trusted' },
        { label: 'Install the cluster', command: 'yaac cluster install', state: 'running' },
      ],
      log: ['$ yaac cluster install', 'Creating the podman machine <img src=x>'],
    }
    polled = { ...fresh, busy: { scope: 'cluster', action: 'setup' }, setup: run }
    document.querySelector<HTMLButtonElement>('button.setup[data-scope="cluster"]')!.click()
    await settle()
    await settle()
    expect(calls.setups).toEqual(['cluster'])
    expect(runEl.hidden).toBe(false)
    expect(document.getElementById('run-title')?.textContent).toBe('Setting up…')
    const steps = [...document.querySelectorAll('#run-steps li')].map((li) => li.textContent)
    expect(steps).toEqual(['– Trust the yaac tap (already trusted)', '… Install the cluster'])
    // Inside the card of the setup that runs.
    expect(runEl.parentElement?.id).toBe('choice-cluster')
    expect(document.getElementById('run-log')?.textContent).toContain('Creating the podman machine <img src=x>')
    expect(document.querySelector('#run img')).toBeNull()
    // One setup or server action at a time.
    expect(document.querySelector<HTMLButtonElement>('button.setup[data-scope="server"]')!.disabled).toBe(true)

    polled = {
      ...fresh,
      setup: { ...run, phase: 'cancelled', error: 'setup cancelled', steps: [run.steps[0], { ...run.steps[1], state: 'cancelled' }] },
    }
    document.getElementById('run-cancel')!.click()
    await settle()
    await settle()
    expect(calls.cancels).toBe(1)
    expect(document.getElementById('run-title')?.textContent).toBe('Setup cancelled')
    expect(document.getElementById('run-error')?.textContent).toBe('setup cancelled')
    expect(document.getElementById('run-cancel')!.hidden).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('button.setup[data-scope="server"]')!.disabled).toBe(false)
  })

  it('shows a refused setup inline, and picks up a run started elsewhere on load', async () => {
    mount({ ...STATE, local: view(NO_CLI) }, { ok: false, error: 'a server action is already running' })
    document.querySelector<HTMLButtonElement>('button.setup[data-scope="server"]')!.click()
    await settle()
    expect(document.getElementById('status')?.textContent).toBe('a server action is already running')

    // A finished run shows beside its own setup only, so a stale one does not linger.
    const failed: DesktopSetupRun = { scope: 'cluster', phase: 'failed', steps: [], log: [], error: 'boom' }
    mount({ ...STATE, local: view(NO_CLI, { setup: failed }) })
    await settle()
    expect(document.getElementById('run')!.hidden).toBe(false)
    mount({ ...STATE, local: view({ server: STOPPED, cluster: NONE }, { setup: failed }) })
    await settle()
    expect(document.getElementById('run')!.hidden).toBe(true)
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
      local: NOTHING_READ,
    })
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('.origin')?.textContent)
      .toBe('https://evil"><img src=x onerror=alert(1)>')
  })
})
