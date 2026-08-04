/**
 * The session-terminal entry points — `listSessionTerminals`,
 * `createShellWindow`, `killWindowTerminal`.
 *
 * Nothing under features/terminals is mocked here: the window-listing parse,
 * the agent-window convention and the scratch-shell naming all run for real,
 * and the fakes start at the pod boundary — `sessionExec` for the one-shot
 * relay exec and the control-stream registry for the watcher's persistent
 * read-only channel. The internals are covered by the listings these tests
 * feed back rather than by tests of their own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as relayModule from '#platform/k8s/stream-relay'
import { sessionExec } from '#platform/k8s/stream-relay'
import {
  registerSessionControlStream,
  _clearControlStreamRegistryForTests,
} from '#features/status/control-stream-registry'
import { createShellWindow, killWindowTerminal, listSessionTerminals } from '#features/terminals'

vi.mock('#platform/k8s/stream-relay', async (importOriginal) => ({
  ...await importOriginal<typeof relayModule>(),
  sessionExec: vi.fn(),
}))

const exec = vi.mocked(sessionExec)
const out = (stdout: string): Promise<{ stdout: string; stderr: string }> =>
  Promise.resolve({ stdout, stderr: '' })

const LIST_FORMAT = "list-windows -t yaac -F '#{window_index}|#{window_id}|#{window_name}'"

beforeEach(() => {
  exec.mockReset()
  _clearControlStreamRegistryForTests()
})

describe('listSessionTerminals', () => {
  it('maps every window but the agent (lowest index), pipes in names and all', async () => {
    exec.mockReturnValueOnce(out('0|@0|claude\n1|@3|dev-server\n2|@5|a|b|c\n'))
    expect(await listSessionTerminals('yaac-demo')).toEqual([
      { target: 'window:@3', name: 'dev-server' },
      { target: 'window:@5', name: 'a|b|c' },
    ])
    expect(exec.mock.calls[0][1]).toContain(LIST_FORMAT)
  })

  it('is empty for a lone agent window, for garbage, and for a failed probe', async () => {
    exec.mockReturnValueOnce(out('0|@0|claude\n'))
    expect(await listSessionTerminals('yaac-demo')).toEqual([])

    exec.mockReturnValueOnce(out('no pipes here\n???\n'))
    expect(await listSessionTerminals('yaac-demo')).toEqual([])

    exec.mockRejectedValueOnce(new Error('pod gone'))
    expect(await listSessionTerminals('yaac-demo')).toEqual([])
  })

  it('rides a registered control stream, falling back to exec when it fails', async () => {
    const sent: string[] = []
    registerSessionControlStream('yaac-demo', (cmd) => {
      sent.push(cmd)
      return Promise.resolve('0|@0|claude\n1|@1|init')
    })
    expect(await listSessionTerminals('yaac-demo')).toEqual([
      { target: 'window:@1', name: 'init' },
    ])
    expect(sent[0]).toContain(LIST_FORMAT)
    expect(exec).not.toHaveBeenCalled()

    // The watcher's stream just died mid-respawn: this call takes the
    // one-shot relay exec instead of failing.
    registerSessionControlStream('yaac-demo', () => Promise.reject(new Error('stream died')))
    exec.mockReturnValueOnce(out('0|@0|claude\n1|@1|init\n'))
    expect(await listSessionTerminals('yaac-demo')).toEqual([
      { target: 'window:@1', name: 'init' },
    ])
    expect(exec).toHaveBeenCalledOnce()
  })
})

describe('createShellWindow', () => {
  it('fills the first free scratch-shell name: shell, shell-2, shell-3, …', async () => {
    const create = async (windows: string): Promise<string> => {
      exec.mockReturnValueOnce(out(windows))
      exec.mockReturnValueOnce(out('@7\n'))
      return (await createShellWindow('yaac-demo')).name
    }
    expect(await create('0|@0|claude\n')).toBe('shell')
    expect(await create('0|@0|claude\n1|@1|shell\n')).toBe('shell-2')
    expect(await create('0|@0|claude\n1|@1|shell\n2|@2|shell-2\n')).toBe('shell-3')
    expect(await create('0|@0|claude\n1|@1|shell\n2|@2|shell-3\n')).toBe('shell-2')
    // Windows that aren't scratch shells never reserve a name.
    expect(await create('0|@0|claude\n1|@1|init\n2|@2|dev-server\n3|@3|shellfish\n')).toBe('shell')
  })

  it('returns the new window id the create printed', async () => {
    exec.mockReturnValueOnce(out('0|@0|claude\n1|@1|shell\n'))
    exec.mockReturnValueOnce(out('@7\n'))
    expect(await createShellWindow('yaac-demo')).toEqual({ target: 'window:@7', name: 'shell-2' })
    expect(exec.mock.calls[1][1]).toContain(
      "new-window -d -P -F '#{window_id}' -t yaac -n shell-2 -c /workspace",
    )
  })

  it('throws when new-window returns no window id', async () => {
    exec.mockReturnValueOnce(out('0|@0|claude\n'))
    exec.mockReturnValueOnce(out('garbage'))
    await expect(createShellWindow('yaac-demo')).rejects.toThrow('no window id')
  })

  it('mutations never ride the (read-only) control stream — only the listing does', async () => {
    const sent: string[] = []
    registerSessionControlStream('yaac-demo', (cmd) => {
      sent.push(cmd)
      return Promise.resolve('0|@0|claude\n1|@1|shell')
    })
    exec.mockReturnValueOnce(out('@7\n'))
    expect(await createShellWindow('yaac-demo')).toEqual({ target: 'window:@7', name: 'shell-2' })
    // The listing rode the stream; the new-window mutation went via exec.
    expect(sent).toHaveLength(1)
    expect(exec).toHaveBeenCalledOnce()
    expect(exec.mock.calls[0][1]).toContain('new-window')

    exec.mockReturnValueOnce(out(''))
    await killWindowTerminal('yaac-demo', 'window:@1')
    expect(sent).toHaveLength(2)
    expect(exec.mock.calls[1][1]).toContain('kill-window -t @1')
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
