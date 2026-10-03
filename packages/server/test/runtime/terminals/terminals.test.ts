/**
 * `listTerminals`, `createShellWindow`, `killWindowTerminal`. Nothing in
 * runtime/terminals is mocked. A listing is handed a fake tmux channel; the
 * driver's `exec` runs create and kill scripts in a real `sh`, with a stub
 * `tmux` on its PATH that lists `windows` and records the mutations.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createShellWindow, killWindowTerminal, listTerminals } from '#runtime/terminals'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { WorkspaceExecError, type WorkspaceDriver } from '#drivers/contract'

const LIST_FORMAT = "list-windows -t yaac -F '#{window_index}|#{window_id}|#{window_name}'"

/** The stub's windows, as `<id> <name>` lines in index order. */
let windows = ''
/** The tmux commands the stub ran, other than listings. */
let ran: string[] = []
let bin = ''

const exec = vi.fn<WorkspaceDriver['exec']>((_jobName, cmd) => new Promise((resolve, reject) => {
  execFile('sh', ['-c', cmd], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WINDOWS: windows } },
    (err, stdout, stderr) => {
      const lines = stdout.split('\n')
      ran.push(...lines.filter((l) => l.startsWith('RAN ')).map((l) => l.slice(4)))
      const out = lines.filter((l) => !l.startsWith('RAN ')).join('\n')
      if (err) reject(new WorkspaceExecError('exit', typeof err.code === 'number' ? err.code : 1, out, stderr))
      else resolve({ stdout: out, stderr })
    })
}))

beforeAll(() => {
  bin = mkdtempSync(path.join(os.tmpdir(), 'yaac-tmux-stub-'))
  writeFileSync(path.join(bin, 'tmux'), [
    '#!/bin/sh',
    'shift 2',
    'case "$1:$*" in',
    "  list-windows:*window_name*) printf '%s\\n' \"$WINDOWS\" | cut -d' ' -f2- ;;",
    "  list-windows:*) printf '%s\\n' \"$WINDOWS\" | cut -d' ' -f1 ;;",
    '  new-window:*) echo "RAN $*"; while [ $# -gt 0 ]; do [ "$1" = -n ] && n=$2; shift; done; echo "@7 $n" ;;',
    '  *) echo "RAN $*" ;;',
    'esac',
  ].join('\n'))
  chmodSync(path.join(bin, 'tmux'), 0o755)
})

beforeEach(() => {
  exec.mockClear()
  windows = ''
  ran = []
  installFakeWorkspaceDriver({ exec })
})

describe('listTerminals', () => {
  it('maps every window but the agent (lowest index), pipes in names and all', async () => {
    const tmux = vi.fn((_args: string) => Promise.resolve('0|@0|claude\n1|@3|dev-server\n2|@5|a|b|c\n'))
    expect(await listTerminals(tmux)).toEqual([
      { target: 'window:@3', name: 'dev-server' },
      { target: 'window:@5', name: 'a|b|c' },
    ])
    expect(tmux).toHaveBeenCalledWith(LIST_FORMAT)
  })

  it('is empty for a lone agent window and for garbage', async () => {
    expect(await listTerminals(() => Promise.resolve('0|@0|claude\n'))).toEqual([])
    expect(await listTerminals(() => Promise.resolve('no pipes here\n???\n'))).toEqual([])
  })
})

describe('createShellWindow', () => {
  it('fills the first free scratch-shell name: shell, shell-2, shell-3, …', async () => {
    const create = async (listed: string): Promise<string> => {
      windows = listed
      return (await createShellWindow('yaac-demo')).name
    }
    expect(await create('@0 claude')).toBe('shell')
    expect(await create('@0 claude\n@1 shell')).toBe('shell-2')
    expect(await create('@0 claude\n@1 shell\n@2 shell-2')).toBe('shell-3')
    expect(await create('@0 claude\n@1 shell\n@2 shell-3')).toBe('shell-2')
    // Only scratch-shell windows reserve a name.
    expect(await create('@0 claude\n@1 init\n@2 dev-server\n@3 shellfish')).toBe('shell')
    // One exec per create.
    expect(exec).toHaveBeenCalledTimes(5)
  })

  it('returns the new window id the create printed', async () => {
    windows = '@0 claude\n@1 shell'
    expect(await createShellWindow('yaac-demo')).toEqual({ target: 'window:@7', name: 'shell-2' })
    expect(ran).toEqual(['new-window -d -P -F #{window_id} #{window_name} -t yaac -n shell-2 -c /workspace'])
  })

  it('throws when new-window returns no window id', async () => {
    exec.mockResolvedValueOnce({ stdout: 'garbage', stderr: '' })
    await expect(createShellWindow('yaac-demo')).rejects.toThrow('no window id')
  })
})

describe('killWindowTerminal', () => {
  it('kills a non-agent window in one exec', async () => {
    windows = '@0 claude\n@1 shell'
    await killWindowTerminal('yaac-demo', 'window:@1')
    expect(ran).toEqual(['kill-window -t @1'])
    expect(exec).toHaveBeenCalledOnce()
  })

  it('refuses the agent window, non-window targets, and blind kills', async () => {
    windows = '@0 claude\n@1 shell'
    await expect(killWindowTerminal('yaac-demo', 'window:@0')).rejects.toThrow('agent window')

    await expect(killWindowTerminal('yaac-demo', 'shell:shell')).rejects.toThrow('not a window target')
    await expect(killWindowTerminal('yaac-demo', "window:@1' \\; kill-server")).rejects.toThrow('not a window target')

    windows = ''
    await expect(killWindowTerminal('yaac-demo', 'window:@1')).rejects.toThrow('refusing to kill blind')
    // No refusal ever ran a kill.
    expect(ran).toEqual([])
  })
})
