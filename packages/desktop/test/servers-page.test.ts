// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { DesktopLocalState, DesktopSetupRun } from '@yaac/shared/types'
import { serversPageHtml, serversPageUrl, type ServersPageState } from '#servers-page'
import { localView } from '#local-setup'
import type { LocalServers, LocalServerState } from '#server-control'

/** No install: what `yaac server|cluster status --json` reports before one exists. */
const NONE = {
  kind: 'status',
  status: { running: false, driver: null, serverBuildId: null, cliBuildId: 'b1', origin: null, refused: null, reachable: null },
} satisfies LocalServerState
const STOPPED: LocalServerState = { kind: 'status', status: { ...NONE.status, driver: 'containerless' } }
const CLUSTER_STOPPED: LocalServerState = { kind: 'status', status: { ...NONE.status, driver: 'k8s' } }
const NO_CLI: LocalServers = { server: { kind: 'no-cli' }, cluster: { kind: 'no-cli' } }
const HOST = 'http://127.0.0.1:8787'
const CLUSTER = 'http://127.0.0.1:8790'
const HOST_RUNNING: LocalServerState = {
  kind: 'status', status: { ...NONE.status, driver: 'containerless', running: true, serverBuildId: 'b1', origin: HOST },
}
const CLUSTER_RUNNING: LocalServerState = { kind: 'status', status: { ...HOST_RUNNING.status, driver: 'k8s', origin: CLUSTER } }

function view(local: LocalServers, more: Partial<Parameters<typeof localView>[0]> = {}): DesktopLocalState {
  return localView({ local, busy: null, setup: null, unfinished: [], brew: true, clusterSupported: true, ...more })
}

const NOTHING_READ = view({ server: null, cluster: null })
/** A stopped host server, and no cluster install. */
const HOST_STOPPED = view({ server: STOPPED, cluster: NONE })

const STATE: ServersPageState = {
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
  tailnet: true,
}

describe('serversPageHtml', () => {
  it('states the failure: title, verbatim detail, and hint', () => {
    const html = serversPageHtml(STATE)
    expect(html).toContain('Could not connect to http://127.0.0.1:8787')
    expect(html).toContain('cannot reach the yaac server at http://127.0.0.1:8787 (fetch failed)')
    expect(html).toContain('Check that the server is running, then connect again.')
  })

  it('offers one Connect row per saved server, most recently selected first, and removes any other', () => {
    const html = serversPageHtml(STATE)
    // The selected row gets one too while it is unreachable: it is the retry.
    expect(html.match(/class="connect" data-url=/g)).toHaveLength(2)
    expect(html.match(/class="disconnect"/g)).toHaveLength(1)
    expect(html.indexOf(`data-url="${HOST}"`)).toBeLessThan(html.indexOf('data-url="https://b.ts.net"'))
    // A remote selected more recently than a local install leads it; an install whose origin is not saved goes last.
    const recent = serversPageHtml({
      ...STATE,
      targets: { current: 'https://b.ts.net', saved: ['https://b.ts.net', HOST] },
      local: view({ server: HOST_RUNNING, cluster: CLUSTER_RUNNING }),
    })
    const at = (needle: string): number => recent.indexOf(needle)
    expect(at('<span class="origin">https://b.ts.net</span>')).toBeLessThan(at('id="install-server"'))
    expect(at('id="install-server"')).toBeLessThan(at('id="install-cluster"'))
    // It is checked only while the window is connected to it.
    expect(html).not.toContain('class="check"')
    expect(html.match(/class="remove" data-url=/g)).toHaveLength(1)
    expect(html).toContain('class="remove" data-url="https://b.ts.net"')
  })

  it('opened over a server, has no failure to state, a way back named for it, and a disconnect', () => {
    const html = serversPageHtml({ targets: STATE.targets, local: view({ server: HOST_RUNNING, cluster: NONE }), tailnet: true })
    expect(html).toContain('<h1>Servers</h1>')
    expect(html).toContain('>← Back to Local containerless server</button>')
    expect(html).toMatch(/<span class="check" title="Connected">✓<\/span>\s*<span class="name">Local containerless server/)
    // A remote server is named by its origin.
    const remote = { current: 'https://b.ts.net', saved: STATE.targets.saved }
    expect(serversPageHtml({ targets: remote, local: NOTHING_READ, tailnet: true }))
      .toMatch(/>← Back to https:\/\/b\.ts\.net<\/button>[\s\S]*class="check"[^<]*<\/span>\s*<span class="origin">https:\/\/b\.ts\.net/)
    // The connected server's row only disconnects; the other connects and removes.
    expect(html).toContain('<button class="disconnect">Disconnect</button>')
    expect(html.match(/class="connect" data-url=/g)).toHaveLength(1)
    expect(html).toContain('class="connect" data-url="https://b.ts.net"')
    expect(html).toContain('id="add"')
    // An unreachable server has no page to go back to; its row's Connect is the retry.
    expect(serversPageHtml(STATE)).not.toContain('id="back"')
  })

  it('says so, and still takes a new server, when nothing is configured', () => {
    const html = serversPageHtml({
      error: { title: 'No yaac server selected' },
      targets: { current: null, saved: [] },
      local: NOTHING_READ,
      tailnet: true,
    })
    expect(html).toContain('No servers configured yet.')
    expect(html).not.toContain('class="connect"')
    expect(html).not.toContain('id="back"')
    expect(html.match(/class="add"/g) ?? []).toHaveLength(1)
    expect(html).toContain('name="url"')
    expect(html).not.toContain('name="token"')
  })

  it('drives the preload bridge, not IPC of its own', () => {
    const html = serversPageHtml(STATE)
    expect(html).toContain('window.yaacServer')
    expect(html).toContain('bridge.switchTo({ url:')
    expect(html).toContain('bridge.addRemote(url)')
    expect(html).toContain('bridge.disconnect()')
    // The native traffic lights are hidden, so the page provides its own.
    expect(html).toContain('window.yaacWindow.close()')
    expect(html).toContain('-webkit-app-region: drag')
  })

  it('escapes server-supplied text rather than letting it close a tag', () => {
    const html = serversPageHtml({
      error: { title: 'x', detail: '<img src=x onerror="alert(1)">' },
      targets: { current: null, saved: ['https://evil"><script>alert(1)</script>'] },
      local: NOTHING_READ,
      tailnet: true,
    })
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;img src=x')
  })

  it('lists this Mac\'s installs by name and origin, each with a Start or Stop', () => {
    const html = serversPageHtml({ ...STATE, local: view({ server: HOST_RUNNING, cluster: CLUSTER_RUNNING }) })
    // The selected host server's row, which stops even though the window uses it.
    expect(html).toMatch(new RegExp('<span class="name">Local containerless server \\(http://127\\.0\\.0\\.1:8787\\)</span>'
      + '\\s*<span class="tag">Running</span>\\s*'
      + '<button class="connect" data-url="http://127.0.0.1:8787">Connect</button><button class="disconnect">Disconnect</button>'
      + '<button class="stop" data-scope="server">Stop</button>'))
    // Listed once, as the install rather than a bare origin.
    expect(html).not.toContain(`<span class="origin">${HOST}</span>`)
    // The cluster's origin is not saved (removed with `yaac remote remove`), so Connect adds it again.
    expect(html).toMatch(new RegExp('Local kubernetes cluster \\(http://127\\.0\\.0\\.1:8790\\)</span>\\s*<span class="tag">Running</span>\\s*'
      + `<button class="connect" data-url="${CLUSTER}" data-add>Connect</button><button class="stop" data-scope="cluster">`))
    expect(html).toContain('<span class="origin">https://b.ts.net</span>')

    // A stopped install has no Connect, since a start selects it, though a selected one still disconnects.
    const selectedStopped: LocalServerState = { kind: 'status', status: { ...HOST_RUNNING.status, running: false } }
    expect(serversPageHtml({ ...STATE, local: view({ server: selectedStopped, cluster: NONE }) })).toMatch(
      /<span class="tag">Stopped<\/span>\s*<button class="disconnect">Disconnect<\/button><button class="start" data-scope="server">/)
    const stopped = serversPageHtml({ ...STATE, local: HOST_STOPPED })
    expect(stopped).toMatch(/Local containerless server<\/span>\s*<span class="tag">Stopped<\/span>\s*<button class="start" data-scope="server">Start<\/button>\s*<\/li>/)
    // An install this Mac lacks offers its setup, folded away, under the list.
    expect(stopped).toContain('<h2>Set up on this Mac</h2>')
    expect(stopped).toMatch(/Local kubernetes cluster<\/span>\s*<span class="tag">Not set up/)
    expect(stopped).toContain('<details class="choice" id="choice-cluster">')
    expect(stopped).not.toContain('id="choice-server"')
    // A scaled-down cluster install starts back up as pods, beside the host server.
    const both = serversPageHtml({ ...STATE, local: view({ server: STOPPED, cluster: CLUSTER_STOPPED }) })
    expect(both).toContain('<button class="start" data-scope="server">')
    expect(both).toContain('<button class="start" data-scope="cluster">')
    expect(both).not.toContain('Set up on this Mac')
    // A ~/.yaac that is itself the cluster install lists only the cluster.
    const legacy = serversPageHtml({ ...STATE, local: view({ server: CLUSTER_STOPPED, cluster: CLUSTER_STOPPED }) })
    expect(legacy).not.toContain('id="install-server"')
    expect(legacy).toContain('<button class="start" data-scope="cluster">')
    const erred = serversPageHtml({ ...STATE, local: view({ server: { kind: 'error', message: 'x' }, cluster: NONE }) })
    expect(erred).toMatch(/<span class="tag">Status unavailable<\/span>\s*<\/li>/)
    // While an action runs it says so in place of the state.
    expect(serversPageHtml({ ...STATE, local: { ...HOST_STOPPED, busy: { scope: 'server', action: 'start' } } }))
      .toContain('<span class="tag">Starting…</span>')
    // Nothing read yet: only the saved servers.
    expect(serversPageHtml(STATE)).not.toContain('id="install-')
  })

  it('leads with both setups when there is no CLI, or no install and no server selected', () => {
    const unselected = { ...STATE, targets: { current: null, saved: [] } }
    for (const state of [{ ...STATE, local: view(NO_CLI) }, { ...unselected, local: view({ server: NONE, cluster: NONE }) }]) {
      const html = serversPageHtml(state)
      expect(html).toContain('Pick where workspaces run')
      expect(html).toContain('<details class="choice" id="choice-server" open>')
      expect(html).toContain('<details class="choice" id="choice-cluster" open>')
      expect(html).toContain('Local containerless server')
      expect(html).toContain('the permission mode defaults to accept-edits')
      expect(html).toContain('Local kubernetes cluster')
      expect(html).toContain('gVisor-sandboxed pod')
      // What a containerless agent can reach, in the badge's words.
      expect(html).toContain('<li>its network access is unfiltered</li>')
      expect(html).toContain('<button class="setup" data-scope="server">')
      expect(html).toContain('<button class="setup" data-scope="cluster">')
      expect(html).not.toContain('class="start"')
    }
    // With no CLI, each setup installs it first, and says which taps it trusts.
    const bare = serversPageHtml({ ...STATE, local: view(NO_CLI) })
    expect(bare).toContain('Running it trusts the Homebrew tap bsklaroff/yaac, which lets Homebrew run')
    expect(bare).toContain('Running it trusts the Homebrew taps bsklaroff/yaac and libkrun/krun (third-party, not yaac\'s)')
    expect(bare).toContain([
      'brew trust bsklaroff/yaac', 'brew install bsklaroff/yaac/yaac-server', 'yaac server start', 'yaac host check',
    ].join('\n'))
    expect(bare).toContain([
      'brew trust bsklaroff/yaac', 'brew install bsklaroff/yaac/yaac-server', 'brew trust libkrun/krun',
      'brew tap libkrun/krun', 'brew install bsklaroff/yaac/yaac-cluster', 'yaac cluster install',
    ].join('\n'))
    // With the CLI already installed (the cask), the server's setup only starts it.
    const cask = serversPageHtml({ ...unselected, local: view({ server: NONE, cluster: NONE }) })
    expect(cask).toContain('<pre class="commands" id="commands-server">yaac server start\nyaac host check</pre>')
    expect(cask).toContain('Running it trusts the Homebrew taps bsklaroff/yaac and libkrun/krun')
    expect(cask).not.toContain('Running it trusts the Homebrew tap bsklaroff/yaac,')
    expect(cask).not.toContain('brew install bsklaroff/yaac/yaac-server')
    expect(cask).toContain('brew install bsklaroff/yaac/yaac-cluster\nyaac cluster install</pre>')
    // With no saved server either, it is a welcome rather than an error.
    const welcome = serversPageHtml({ ...unselected, local: view(NO_CLI) })
    expect(welcome).toContain('<h1>Set up yaac</h1>')
    expect(welcome).not.toContain('Could not connect')
    expect(welcome).not.toContain('<h2>Servers</h2>')
    expect(welcome).toContain('id="add"')
    // A fresh Mac has nothing to retry, with or without the CLI.
    expect(welcome).not.toContain('id="back"')
    expect(welcome).not.toContain('Try again')
    expect(cask).toContain('<h1>Set up yaac</h1>')
    expect(cask).not.toContain('id="back"')
    expect(serversPageHtml({ ...STATE, local: view(NO_CLI) })).toContain('Could not connect to http://127.0.0.1:8787')
    // A selected server that is down is not a fresh Mac: its setups stay folded.
    const down = serversPageHtml({ ...STATE, local: view({ server: NONE, cluster: NONE }) })
    expect(down).toContain('<details class="choice" id="choice-server">')
    expect(down).not.toContain('Pick where workspaces run')
    // A Mac with one install is not a fresh Mac either.
    expect(serversPageHtml({ ...unselected, local: view({ server: STOPPED, cluster: NONE }) }))
      .toContain('<details class="choice" id="choice-cluster">')
  })

  it('says what a setup lacks, and turns its button off', () => {
    const html = serversPageHtml({ ...STATE, local: view(NO_CLI, { brew: false, clusterSupported: false }) })
    expect(html).toContain('<button class="setup" data-scope="server" disabled data-blocked>')
    expect(html).toContain('Homebrew is not installed')
    expect(html).toContain('href="https://brew.sh"')
    expect(html).toContain('<button class="setup" data-scope="cluster" disabled data-blocked>')
    expect(html).toContain('it needs macOS on Apple silicon')
    // With the CLI there, the containerless setup needs no Homebrew.
    const cli = serversPageHtml({ ...STATE, targets: { current: null, saved: [] }, local: view({ server: NONE, cluster: NONE }, { brew: false }) })
    expect(cli).toContain('<button class="setup" data-scope="server">')
    expect(cli).toContain('<button class="setup" data-scope="cluster" disabled data-blocked>')
  })

  it('off the tailnet, warns if any remote server is saved, and still lets it be connected to', () => {
    const html = serversPageHtml({ ...STATE, tailnet: false })
    expect(html).toContain('<p class="banner">Tailscale does not seem to be running on this Mac.')
    expect(html).toContain('<button class="connect" data-url="https://b.ts.net">Connect</button>')
    expect(serversPageHtml(STATE)).not.toContain('class="banner"')
    const localOnly = { current: STATE.targets.current, saved: [HOST] }
    expect(serversPageHtml({ ...STATE, targets: localOnly, tailnet: false })).not.toContain('class="banner"')
  })

  it('opens the setup the tray asks for', () => {
    const local = view({ server: NONE, cluster: NONE })
    const html = serversPageHtml({ targets: STATE.targets, local, setup: 'cluster', tailnet: true })
    expect(html).toContain('<details class="choice" id="choice-cluster" open>')
    expect(html).toContain('<details class="choice" id="choice-server">')
    expect(html).toContain('class="connect"')
  })
})

describe('serversPageUrl', () => {
  it('is a data: URL whose decoded body is the page', () => {
    const url = serversPageUrl(STATE)
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true)
    const decoded = decodeURIComponent(url.slice('data:text/html;charset=utf-8,'.length))
    expect(decoded).toBe(serversPageHtml(STATE))
  })
})

/** The page's inline script, run against jsdom and a stub preload bridge. */
describe('serversPageHtml (running in a document)', () => {
  interface Calls {
    switchTo: unknown[]; addRemote: unknown[][]; removed: unknown[]; disconnects: number; closed: number; back: number
    started: unknown[]; stopped: unknown[]; setups: unknown[]; cancels: number
  }

  /** What the bridge's `localState` answers, which a test changes as a setup moves on. */
  let polled: DesktopLocalState = NOTHING_READ
  /** What the bridge's `serverHealth` answers. */
  let health: Record<string, unknown> = {}

  function mount(state: ServersPageState, outcome: unknown = { ok: false, error: 'cannot reach it' }) {
    polled = state.local
    const calls: Calls = {
      switchTo: [], addRemote: [], removed: [], disconnects: 0, closed: 0, back: 0, started: [], stopped: [], setups: [], cancels: 0,
    }
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
      remove: (sel: unknown) => {
        calls.removed.push(sel)
        return Promise.resolve(outcome)
      },
      disconnect: () => {
        calls.disconnects += 1
        return Promise.resolve(outcome)
      },
      back: () => {
        calls.back += 1
        return Promise.resolve({ ok: true })
      },
      startLocal: (scope: unknown) => {
        calls.started.push(scope)
        return Promise.resolve(outcome)
      },
      stopLocal: (scope: unknown) => {
        calls.stopped.push(scope)
        return Promise.resolve(outcome)
      },
      serverHealth: () => Promise.resolve(health),
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
  function render(state: ServersPageState): void {
    const parsed = new DOMParser().parseFromString(serversPageHtml(state), 'text/html')
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

  it('Back re-runs the flow to uncover the server the page was opened over', async () => {
    const calls = mount({ targets: STATE.targets, local: NOTHING_READ, tailnet: true })
    document.getElementById('back')?.click()
    await settle()
    expect(calls.back).toBe(1)
    expect(document.getElementById('status')?.textContent).toContain('Connecting…')
  })

  it('marks each saved server that does not answer or refuses this device, once the page has loaded', async () => {
    const reason = 'https://b.ts.net refused to identify this device: this device is a tagged device'
    health = { 'http://127.0.0.1:8787': { kind: 'stopped' }, 'https://b.ts.net': { kind: 'refused', reason } }
    mount(STATE)
    const tag = (url: string) => document.querySelector<HTMLElement>(`.tag.health[data-url="${url}"]`)!
    // Hidden until the probes come back.
    expect(tag('https://b.ts.net').hidden).toBe(true)
    await settle()
    expect(tag('http://127.0.0.1:8787').textContent).toBe('(stopped)')
    expect(tag('http://127.0.0.1:8787').title).toBe('')
    expect(tag('https://b.ts.net').hidden).toBe(false)
    expect(tag('https://b.ts.net').textContent).toBe('(refused)')
    expect(tag('https://b.ts.net').title).toBe(reason)

    health = {}
    mount(STATE)
    await settle()
    expect(tag('https://b.ts.net').hidden).toBe(true)
  })

  it('Remove sends the row\'s origin, and shows a refusal inline', async () => {
    const calls = mount(STATE, { ok: false, error: 'unknown server' })
    document.querySelector<HTMLButtonElement>('button.remove')!.click()
    expect(document.getElementById('status')?.textContent).toBe('Removing…')
    await settle()
    expect(calls.removed).toEqual([{ url: 'https://b.ts.net' }])
    expect(document.getElementById('status')?.textContent).toBe('unknown server')
  })

  it('Disconnect deselects the server, and shows a refusal inline', async () => {
    const calls = mount(STATE, { ok: false, error: 'no server is selected' })
    document.querySelector<HTMLButtonElement>('button.disconnect')!.click()
    expect(document.getElementById('status')?.textContent).toBe('Disconnecting…')
    await settle()
    expect(calls.disconnects).toBe(1)
    expect(document.getElementById('status')?.textContent).toBe('no server is selected')
  })

  it('Connect on an install whose origin is not saved adds it again, rather than switching', async () => {
    const calls = mount({ ...STATE, local: view({ server: NONE, cluster: CLUSTER_RUNNING }) })
    document.querySelector<HTMLButtonElement>(`button.connect[data-url="${CLUSTER}"]`)!.click()
    await settle()
    expect(calls.addRemote).toEqual([[CLUSTER]])
    expect(calls.switchTo).toEqual([])
  })

  it('a stop button stops its server', async () => {
    const running: LocalServerState = { kind: 'status', status: { ...NONE.status, driver: 'containerless', running: true, serverBuildId: 'b1' } }
    const calls = mount({ ...STATE, local: view({ server: running, cluster: NONE }) }, { ok: true })
    document.querySelector<HTMLButtonElement>('button.stop[data-scope="server"]')!.click()
    await settle()
    expect(calls.stopped).toEqual(['server'])
    expect(document.getElementById('status')?.textContent).toBe('Stopping the server…')
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
    // Inside the card of the setup that runs, unfolded.
    expect(runEl.parentElement?.id).toBe('choice-cluster')
    expect((runEl.parentElement as HTMLDetailsElement).open).toBe(true)
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
    mount({ ...STATE, local: view({ server: STOPPED, cluster: CLUSTER_STOPPED }, { setup: failed }) })
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
      tailnet: true,
    })
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('.origin')?.textContent)
      .toBe('https://evil"><img src=x onerror=alert(1)>')
  })
})
