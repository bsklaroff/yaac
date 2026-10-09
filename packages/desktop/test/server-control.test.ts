import { execFile } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { LocalServerStatus } from '@yaac/shared/types'
import {
  ACTION_TIMEOUT_MS, createRunYaac, readLocalServer, READ_TIMEOUT_MS, runServerAction, trayServerItems,
  type RunYaac, type YaacResult,
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
  it('parses the status, and tells a missing CLI from a failing one', async () => {
    expect(await readLocalServer(fakeYaac({ 'server status --json': statusReply({}) }).run))
      .toEqual({ kind: 'status', status: STATUS })
    expect(await readLocalServer(fakeYaac({}).run)).toEqual({ kind: 'no-cli' })
    expect(await readLocalServer(fakeYaac({ 'server status --json': { ok: false, stderr: 'broken install\n' } }).run))
      .toEqual({ kind: 'error', message: 'broken install' })
  })
})

describe('trayServerItems', () => {
  const items = (s: Partial<LocalServerStatus>) => trayServerItems({ kind: 'status', status: { ...STATUS, ...s } }, null)

  it('offers one action per state, and a restart when the server is on another build', () => {
    const stop = { label: 'Stop this Mac\'s server', action: 'stop' }
    expect(items({ running: false, serverBuildId: null })).toEqual([
      { label: 'This Mac\'s server: stopped' }, { label: 'Start this Mac\'s server', action: 'start' },
    ])
    expect(items({})).toEqual([{ label: 'This Mac\'s server: running' }, stop])
    expect(items({ serverBuildId: 'old' })).toEqual([
      { label: 'This Mac\'s server: running an older build' },
      { label: 'Restart this Mac\'s server to update', action: 'restart' },
    ])
    // A kind install's restart rolls the same image, so only cluster install updates it.
    expect(items({ driver: 'k8s', serverBuildId: 'old' })).toEqual([
      { label: 'Update this Mac\'s server with `yaac cluster install`' }, stop,
    ])
  })

  it('shows no action while one runs, or when the server cannot be driven from here', () => {
    expect(trayServerItems({ kind: 'status', status: STATUS }, 'restart'))
      .toEqual([{ label: 'Restarting this Mac\'s server…' }])
    expect(items({ running: null })).toEqual([{ label: 'This Mac\'s server runs on its cluster' }])
    expect(trayServerItems({ kind: 'no-cli' }, null)).toEqual([{ label: 'No yaac CLI on PATH' }])
    expect(trayServerItems(null, null)).toEqual([])
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

  it('after starting a containerless server, returns the host check\'s failures alone', async () => {
    const { run, calls } = fakeYaac({
      'server start': {},
      'server status --json': statusReply({}),
      'host check': { ok: false, stdout: HOST_CHECK_FAIL },
    })
    expect(await runServerAction('start', run)).toEqual({
      ok: true,
      hostCheckFailures: '✗ claude: not on PATH\n    fix: npm install -g @anthropic-ai/claude-code',
    })
    expect(calls).toEqual(['server start @action', 'server status --json @read', 'host check @read'])
  })

  it('skips the host check for a k8s start and for a stop, and surfaces a refusal', async () => {
    const k8s = fakeYaac({ 'server start': {}, 'server status --json': statusReply({ driver: 'k8s' }) })
    expect(await runServerAction('start', k8s.run)).toEqual({ ok: true })
    expect(k8s.calls).not.toContain('host check @read')

    const stop = fakeYaac({ 'server stop': {} })
    expect(await runServerAction('stop', stop.run)).toEqual({ ok: true })
    expect(stop.calls).toEqual(['server stop @action'])

    const refused = fakeYaac({ 'server start': { ok: false, stderr: 'this install runs on k8s\n' } })
    expect(await runServerAction('start', refused.run)).toEqual({ ok: false, error: 'this install runs on k8s' })
    expect(await runServerAction('restart', fakeYaac({}).run)).toMatchObject({ ok: false, error: /yaac-server/ })
  })
})
