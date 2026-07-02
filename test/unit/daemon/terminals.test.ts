import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as execModule from '@/lib/k8s/exec'
import { containerExec } from '@/lib/k8s/exec'
import {
  createShellWindow,
  killWindowTerminal,
  listSessionTerminals,
  nextShellName,
  parseWindowList,
} from '@/daemon/terminals'

vi.mock('@/lib/k8s/exec', async (importOriginal) => ({
  ...await importOriginal<typeof execModule>(),
  containerExec: vi.fn(),
}))

const exec = vi.mocked(containerExec)
const out = (stdout: string): Promise<{ stdout: string; stderr: string }> =>
  Promise.resolve({ stdout, stderr: '' })

beforeEach(() => {
  exec.mockReset()
})

describe('parseWindowList', () => {
  it('skips the agent (lowest-index) window and maps the rest', () => {
    const list = parseWindowList('0|@0|claude\n1|@3|dev-server\n2|@5|watcher\n')
    expect(list).toEqual([
      { target: 'window:@3', name: 'dev-server' },
      { target: 'window:@5', name: 'watcher' },
    ])
  })

  it('returns empty for a single-window session and garbage input', () => {
    expect(parseWindowList('0|@0|claude\n')).toEqual([])
    expect(parseWindowList('')).toEqual([])
    expect(parseWindowList('no pipes here\n???')).toEqual([])
  })

  it('keeps window names containing pipes intact', () => {
    expect(parseWindowList('0|@0|claude\n1|@1|a|b|c')).toEqual([
      { target: 'window:@1', name: 'a|b|c' },
    ])
  })
})

describe('nextShellName', () => {
  it('fills the first gap: shell, then shell-2, shell-3, …', () => {
    const entries = (...names: string[]): Parameters<typeof nextShellName>[0] =>
      names.map((name, i) => ({ target: `window:@${i + 1}`, name }))
    expect(nextShellName([])).toBe('shell')
    expect(nextShellName(entries('shell'))).toBe('shell-2')
    expect(nextShellName(entries('shell', 'shell-2'))).toBe('shell-3')
    expect(nextShellName(entries('shell', 'shell-3'))).toBe('shell-2')
    // non-shell window names don't count
    expect(nextShellName(entries('init', 'dev-server'))).toBe('shell')
  })
})

describe('listSessionTerminals', () => {
  it('lists the yaac windows and swallows probe failures', async () => {
    exec.mockReturnValueOnce(out('0|@0|claude\n1|@1|init\n'))
    expect(await listSessionTerminals('yaac-demo')).toEqual([
      { target: 'window:@1', name: 'init' },
    ])
    expect(exec.mock.calls[0][1]).toContain("list-windows -t yaac -F '#{window_index}|#{window_id}|#{window_name}'")

    exec.mockRejectedValueOnce(new Error('pod gone'))
    expect(await listSessionTerminals('yaac-demo')).toEqual([])
  })
})

describe('createShellWindow', () => {
  it('creates the next free shell window and returns its id', async () => {
    exec.mockReturnValueOnce(out('0|@0|claude\n1|@1|shell\n'))
    exec.mockReturnValueOnce(out('@7\n'))
    expect(await createShellWindow('yaac-demo')).toEqual({ target: 'window:@7', name: 'shell-2' })
    expect(exec.mock.calls[1][1]).toContain("new-window -d -P -F '#{window_id}' -t yaac -n shell-2 -c /workspace")
  })

  it('throws when new-window returns no window id', async () => {
    exec.mockReturnValueOnce(out('0|@0|claude\n'))
    exec.mockReturnValueOnce(out('garbage'))
    await expect(createShellWindow('yaac-demo')).rejects.toThrow('no window id')
  })
})

describe('killWindowTerminal', () => {
  it('kills a non-agent window', async () => {
    exec.mockReturnValueOnce(out('0|@0|claude\n1|@1|shell\n'))
    exec.mockReturnValueOnce(out(''))
    await killWindowTerminal('yaac-demo', 'window:@1')
    expect(exec.mock.calls[1][1]).toContain('kill-window -t @1')
  })

  it('refuses the agent window, non-window targets, and blind kills', async () => {
    exec.mockReturnValueOnce(out('0|@0|claude\n1|@1|shell\n'))
    await expect(killWindowTerminal('yaac-demo', 'window:@0')).rejects.toThrow('agent window')

    await expect(killWindowTerminal('yaac-demo', 'shell:shell')).rejects.toThrow('not a window target')
    await expect(killWindowTerminal('yaac-demo', "window:@1' \\; kill-server")).rejects.toThrow('not a window target')

    exec.mockRejectedValueOnce(new Error('probe failed'))
    await expect(killWindowTerminal('yaac-demo', 'window:@1')).rejects.toThrow('refusing to kill blind')
    // only listings ran across all the refusals — never a kill
    expect(exec.mock.calls.filter(([, cmd]) => cmd.includes('kill-window'))).toHaveLength(0)
  })
})
