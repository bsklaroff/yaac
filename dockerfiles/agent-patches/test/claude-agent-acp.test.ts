import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { patchClaudeAgentAcp } from '../claude-agent-acp.js'

/**
 * Patches the pinned adapter's `idle-compaction.js`, loads it, and drives
 * its `IdleCompaction` as the adapter does, with a stand-in `tmux` on PATH
 * that answers the window option from `FAKE_OPTION`.
 */

const require = createRequire(import.meta.url)
const ADAPTER = path.dirname(require.resolve('@agentclientprotocol/claude-agent-acp/package.json'))

interface IdleCompaction {
  noteRequest(usage: unknown, messageId?: string): void
  onIdle(): void
  dispose(): void
}

describe('patchClaudeAgentAcp', () => {
  let dir: string
  const saved = { PATH: process.env.PATH, TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, FAKE_OPTION: process.env.FAKE_OPTION }
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k)
      else process.env[k] = v
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('compacts an idle session only while its window option is on, read afresh at each idle', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-claude-acp-patch-'))
    const source = fs.readFileSync(path.join(ADAPTER, 'dist', 'idle-compaction.js'), 'utf8')
    const patched = patchClaudeAgentAcp(source)
    expect(patchClaudeAgentAcp(patched)).toBe(patched)
    fs.writeFileSync(path.join(dir, 'idle-compaction.mjs'), patched)
    fs.writeFileSync(path.join(dir, 'tmux'), [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${dir}/calls`,
      '[ -n "$FAKE_OPTION" ] && printf "%s\\n" "$FAKE_OPTION"',
      'exit 0',
    ].join('\n'), { mode: 0o755 })
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`
    process.env.TMUX = '/tmp/yaac-tmux/server,1,0'
    process.env.TMUX_PANE = '%7'

    const { IdleCompaction: Compaction } = await import(pathToFileURL(path.join(dir, 'idle-compaction.mjs')).href) as {
      IdleCompaction: new (host: object, options: object) => IdleCompaction
    }
    const logs: string[] = []
    const compaction = new Compaction({
      isBusy: () => false,
      contextTokens: () => 300_000,
      settings: () => ({}),
      compact: async () => {},
      log: (m: string) => logs.push(m),
    }, { env: {}, setTimeout: () => ({ unref() {} }) })
    compaction.noteRequest({ cache_creation: { ephemeral_1h_input_tokens: 10 } }, 'm1')

    // Unset, as for a session launched without it, is off.
    compaction.onIdle()
    expect(logs.at(-1)).toBe('[idle-compaction] skip: disabled by yaac session option')
    process.env.FAKE_OPTION = 'on'
    compaction.onIdle()
    expect(logs.at(-1)).toMatch(/^\[idle-compaction\] armed deadline=/)
    process.env.FAKE_OPTION = 'off'
    compaction.onIdle()
    expect(logs.at(-1)).toBe('[idle-compaction] skip: disabled by yaac session option')
    compaction.dispose()

    // It asks the server the pane belongs to, about the pane's window.
    expect(fs.readFileSync(path.join(dir, 'calls'), 'utf8').split('\n')[0])
      .toBe('-S /tmp/yaac-tmux/server show-options -wqv -t %7 @yaac-idle-compaction')
  })
})
