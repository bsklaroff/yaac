import { execFile } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopSetupRun, LocalServerStatus } from '@yaac/shared/types'
import { localView } from '#local-setup'
import {
  ACTION_TIMEOUT_MS, createRunYaac, mayControlLocalServers, readLocalServer, READ_TIMEOUT_MS, runServerAction,
  trayServerItems,
  type LocalServers, type RunYaac, type YaacResult,
} from '#server-control'

const STATUS: LocalServerStatus = { running: true, driver: 'containerless', serverBuildId: 'b1', cliBuildId: 'b1' }

/**
 * A `yaac` that answers each command line from `replies`, recording each
 * call with the timeout it was given.
 */
function fakeYaac(replies: Record<string, Partial<YaacResult>>): { run: RunYaac, calls: string[] } {
  const calls: string[] = []
  const run: RunYaac = (args, timeoutMs) => {
    const line = args.join(' ')
    calls.push(`${line} @${timeoutMs === READ_TIMEOUT_MS ? 'read' : timeoutMs === ACTION_TIMEOUT_MS ? 'action' : timeoutMs}`)
    const reply = replies[line]
    if (!reply) return Promise.reject(Object.assign(new Error('spawn yaac ENOENT'), { code: 'ENOENT' }))
    return Promise.resolve({ ok: true, stdout: '', stderr: '', ...reply })
  }
  return { run, calls }
}

const statusReply = (s: Partial<LocalServerStatus>): Partial<YaacResult> => ({ stdout: JSON.stringify({ ...STATUS, ...s }) })

describe('createRunYaac', () => {
  it('resolves a failing exit with its output and rejects only when yaac is missing', async () => {
    const exec = vi.fn((_file: string, _args: string[], _opts: object, cb: (err: unknown, out: string, errOut: string) => void) => {
      cb(Object.assign(new Error('exit 1'), { code: 1 }), 'out', 'refused')
    })
    const run = createRunYaac(exec as never)
    expect(await run(['server', 'start'], 1000)).toEqual({ ok: false, stdout: 'out', stderr: 'refused' })
    expect(exec.mock.calls[0].slice(0, 3)).toEqual(['yaac', ['server', 'start'], { timeout: 1000 }])

    const missing = createRunYaac(((_f: string, _a: string[], _o: object, cb: (err: unknown) => void) => {
      cb(Object.assign(new Error('spawn yaac ENOENT'), { code: 'ENOENT' }))
    }) as never)
    await expect(missing(['server', 'status'], 1000)).rejects.toThrow(/not on PATH/)
  })

  it('fails a yaac that outlives its timeout', async () => {
    const hung = createRunYaac(((_f: string, args: string[], opts: { timeout: number }, cb: (err: unknown, out: string, errOut: string) => void) => {
      // A real process under the same timeout, standing in for a hung `yaac`.
      execFile('sleep', ['5'], opts, cb)
    }) as never)
    expect(await hung(['server', 'status', '--json'], 100))
      .toEqual({ ok: false, stdout: '', stderr: 'yaac server status --json timed out' })
  })
})

describe('readLocalServer', () => {
  it('parses each scope\'s status, and tells a missing CLI from a failing one', async () => {
    expect(await readLocalServer(fakeYaac({ 'server status --json': statusReply({}) }).run, 'server'))
      .toEqual({ kind: 'status', status: STATUS })
    expect(await readLocalServer(fakeYaac({ 'cluster status --json': statusReply({ driver: 'k8s' }) }).run, 'cluster'))
      .toEqual({ kind: 'status', status: { ...STATUS, driver: 'k8s' } })
    expect(await readLocalServer(fakeYaac({}).run, 'server')).toEqual({ kind: 'no-cli' })
    expect(await readLocalServer(fakeYaac({ 'server status --json': { ok: false, stderr: 'broken install\n' } }).run, 'server'))
      .toEqual({ kind: 'error', message: 'broken install' })
  })
})

describe('trayServerItems', () => {
  const status = (s: Partial<LocalServerStatus>) => ({ kind: 'status' as const, status: { ...STATUS, ...s } })
  /** A cluster status as `yaac cluster status --json` reports one. */
  const kind = (s: Partial<LocalServerStatus> = {}) => status({ driver: 'k8s', ...s })
  const NO_INSTALL = status({ driver: null, running: false, serverBuildId: null })
  const tray = (local: LocalServers, more: Partial<Parameters<typeof localView>[0]> = {}) =>
    trayServerItems(localView({ local, busy: null, setup: null, unfinished: [], brew: true, clusterSupported: true, ...more }))
  const items = (s: Partial<LocalServerStatus>) => tray({ server: status(s), cluster: NO_INSTALL }).slice(0, -1)
  const hostStop = { label: 'Stop this Mac\'s server', action: { scope: 'server', action: 'stop' } }
  const clusterStop = { label: 'Stop this Mac\'s cluster server', action: { scope: 'cluster', action: 'stop' } }
  const setUpHost = { label: 'Set up a server on this Mac…', action: { scope: 'server', action: 'setup' } }
  const setUpCluster = { label: 'Set up a cluster on this Mac…', action: { scope: 'cluster', action: 'setup' } }

  it('offers one action per state, and a restart when the host server is on another build', () => {
    expect(items({ running: false, serverBuildId: null })).toEqual([
      { label: 'This Mac\'s server: stopped' },
      { label: 'Start this Mac\'s server', action: { scope: 'server', action: 'start' } },
    ])
    expect(items({})).toEqual([{ label: 'This Mac\'s server: running' }, hostStop])
    expect(items({ serverBuildId: 'old' })).toEqual([
      { label: 'This Mac\'s server: running an older build' },
      { label: 'Restart this Mac\'s server to update', action: { scope: 'server', action: 'restart' } },
    ])
  })

  it('offers the setup of each install this Mac lacks, and only the setups it can run', () => {
    expect(tray({ server: NO_INSTALL, cluster: NO_INSTALL })).toEqual([setUpHost, setUpCluster])
    expect(tray({ server: { kind: 'no-cli' }, cluster: { kind: 'no-cli' } }))
      .toEqual([{ label: 'No yaac CLI on PATH' }, setUpHost, setUpCluster])
    // Without Homebrew the setup still opens, to say so.
    expect(tray({ server: { kind: 'no-cli' }, cluster: { kind: 'no-cli' } }, { brew: false, clusterSupported: false }))
      .toEqual([{ label: 'No yaac CLI on PATH' }, setUpHost])
  })

  it('offers setup again for an install whose setup never finished, until it runs', () => {
    const halfInstalled = { server: status({}), cluster: kind({ running: false, serverBuildId: null }) }
    expect(tray(halfInstalled, { unfinished: ['cluster'] }))
      .toEqual([{ label: 'This Mac\'s server: running' }, hostStop, setUpCluster])
    expect(tray({ ...halfInstalled, cluster: kind() }, { unfinished: ['cluster'] }).slice(-1)).toEqual([clusterStop])
  })

  it('lists a cluster install\'s server beside the host one, updated only by `cluster install`', () => {
    const host = status({ running: false, serverBuildId: null })
    expect(tray({ server: host, cluster: kind({ running: false, serverBuildId: null }) })).toEqual([
      { label: 'This Mac\'s server: stopped' },
      { label: 'Start this Mac\'s server', action: { scope: 'server', action: 'start' } },
      { label: 'This Mac\'s cluster server: stopped' },
      { label: 'Start this Mac\'s cluster server', action: { scope: 'cluster', action: 'start' } },
    ])
    // A restart rolls the same image, so only cluster install updates it.
    expect(tray({ server: null, cluster: kind({ serverBuildId: 'old' }) })).toEqual([
      { label: 'Update this Mac\'s cluster server with `yaac cluster install`' }, clusterStop,
    ])
    expect(tray({ server: null, cluster: kind({ running: null, serverBuildId: null }) }))
      .toEqual([{ label: 'This Mac\'s cluster server runs on its cluster' }])
    // A ~/.yaac that is itself the cluster install shows once, as the cluster.
    expect(tray({ server: kind(), cluster: kind() })).toEqual([
      { label: 'This Mac\'s cluster server: running' }, clusterStop,
    ])
  })

  it('shows no action while one runs, with a setup\'s step, or when the server cannot be driven from here', () => {
    expect(tray({ server: status({}), cluster: kind() }, { busy: { scope: 'cluster', action: 'restart' } }))
      .toEqual([{ label: 'Restarting this Mac\'s cluster server…' }])
    const setup: DesktopSetupRun = {
      scope: 'cluster',
      phase: 'running',
      log: [],
      steps: [
        { label: 'Trust the yaac tap', command: 'brew trust bsklaroff/yaac', state: 'skipped' },
        { label: 'Install the cluster', command: 'yaac cluster install', state: 'running' },
      ],
    }
    expect(tray({ server: NO_INSTALL, cluster: NO_INSTALL }, { busy: { scope: 'cluster', action: 'setup' }, setup }))
      .toEqual([{ label: 'Setting up this Mac\'s cluster server…' }, { label: 'Step 2 of 2: Install the cluster' }])
    expect(tray({ server: { kind: 'error', message: 'x' }, cluster: { kind: 'error', message: 'x' } }))
      .toEqual([{ label: 'This Mac\'s server: status unavailable' }, { label: 'This Mac\'s cluster server: status unavailable' }])
    // An older yaac without `cluster status` still shows the host server.
    expect(tray({ server: status({}), cluster: { kind: 'error', message: 'unknown command' } }))
      .toEqual([{ label: 'This Mac\'s server: running' }, hostStop, { label: 'This Mac\'s cluster server: status unavailable' }])
    expect(tray({ server: null, cluster: null })).toEqual([])
  })
})

describe('mayControlLocalServers', () => {
  it('admits the shell\'s own picker and pages from this machine\'s loopback, and nothing else', () => {
    for (const url of ['data:text/html;charset=utf-8,%3C!doctype', 'http://127.0.0.1:8787/', 'http://localhost:1420/x', 'http://[::1]:8790/']) {
      expect(mayControlLocalServers(url)).toBe(true)
    }
    for (const url of ['https://srv.tail1234.ts.net/', 'http://10.42.44.100:9455/', 'file://localhost/etc/passwd', 'about:blank', '']) {
      expect(mayControlLocalServers(url)).toBe(false)
    }
  })
})

describe('runServerAction', () => {
  const HOST_CHECK_FAIL = [
    '✓ tmux: on PATH',
    '✗ claude: not on PATH',
    '    fix: npm install -g @anthropic-ai/claude-code',
    '! isolation: none',
    '    fix: Workspaces are not sandboxed.',
  ].join('\n')

  it('after starting the host server, returns the host check\'s failures alone', async () => {
    const { run, calls } = fakeYaac({
      'server start': {},
      'host check': { ok: false, stdout: HOST_CHECK_FAIL },
    })
    expect(await runServerAction({ scope: 'server', action: 'start' }, run)).toEqual({
      ok: true,
      hostCheckFailures: '✗ claude: not on PATH\n    fix: npm install -g @anthropic-ai/claude-code',
    })
    expect(calls).toEqual(['server start @action', 'host check @read'])
  })

  it('skips the host check for a cluster start and for a stop, and surfaces a refusal', async () => {
    const cluster = fakeYaac({ 'cluster start': {} })
    expect(await runServerAction({ scope: 'cluster', action: 'start' }, cluster.run)).toEqual({ ok: true })
    expect(cluster.calls).toEqual(['cluster start @action'])

    const stop = fakeYaac({ 'server stop': {} })
    expect(await runServerAction({ scope: 'server', action: 'stop' }, stop.run)).toEqual({ ok: true })
    expect(stop.calls).toEqual(['server stop @action'])

    const refused = fakeYaac({ 'server start': { ok: false, stderr: 'this data dir is a cluster install\n' } })
    expect(await runServerAction({ scope: 'server', action: 'start' }, refused.run))
      .toEqual({ ok: false, error: 'this data dir is a cluster install' })
    expect(await runServerAction({ scope: 'server', action: 'restart' }, fakeYaac({}).run))
      .toMatchObject({ ok: false, error: /yaac-server/ })
  })
})
