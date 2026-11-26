import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { patchClaudeAgentAcp } from '../claude-agent-acp.js'

/**
 * Patches files of the pinned adapter, loads them, and drives them as the
 * adapter does: `IdleCompaction` with a stand-in `tmux` on PATH that answers
 * the window option from `FAKE_OPTION`, `AuthStatusReporter` with a
 * stand-in claude CLI that records being run, and `newSession` with a
 * `createSession` that records what it is asked for.
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
  const saved = {
    PATH: process.env.PATH, TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, FAKE_OPTION: process.env.FAKE_OPTION,
    CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE,
  }
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
    const patched = patchClaudeAgentAcp(source, 'idle-compaction.js')
    expect(patchClaudeAgentAcp(patched, 'idle-compaction.js')).toBe(patched)
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

  it('answers the login probe from what the session reported, without running claude', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-claude-acp-patch-'))
    const dist = path.join(fs.realpathSync(ADAPTER), 'dist')
    // The copy imports its siblings from the adapter, and packages from the
    // adapter's own node_modules.
    fs.symlinkSync(path.resolve(dist, '../../..'), path.join(dir, 'node_modules'))
    const source = fs.readFileSync(path.join(dist, 'auth-status-reporter.js'), 'utf8')
    fs.writeFileSync(path.join(dir, 'patched.mjs'), patchClaudeAgentAcp(source, 'auth-status-reporter.js')
      .replaceAll('from "./', `from "${pathToFileURL(dist).href}/`))
    fs.writeFileSync(path.join(dir, 'claude'), [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${dir}/calls`,
      `printf '%s\\n' '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'`,
    ].join('\n'), { mode: 0o755 })
    process.env.CLAUDE_CODE_EXECUTABLE = path.join(dir, 'claude')

    interface Reporter {
      probe(): Promise<unknown>
      status(): Promise<unknown>
      publishSessionAccount(account: object): void
    }
    const reporter = async (file: string): Promise<{ it: Reporter; pushed: unknown[] }> => {
      const { AuthStatusReporter } = await import(pathToFileURL(file).href) as {
        AuthStatusReporter: new (options: object) => Reporter
      }
      const pushed: unknown[] = []
      return {
        pushed,
        it: new AuthStatusReporter({
          logger: { log() {}, error() {} },
          push: (status: unknown) => { pushed.push(status) },
          pushAcp() {},
          gatewayLogin: () => false,
          providerOverride: () => false,
        }),
      }
    }
    const calls = (): string => fs.readFileSync(path.join(dir, 'calls'), 'utf8')

    // The release as published runs the CLI for it.
    const published = await reporter(path.join(dist, 'auth-status-reporter.js'))
    await published.it.probe()
    expect(calls()).toBe('auth status --json\n')

    const patched = await reporter(path.join(dir, 'patched.mjs'))
    expect(await patched.it.probe()).toBeUndefined()
    patched.it.publishSessionAccount({ email: 'a@example.com', subscriptionType: 'max', tokenSource: 'claude.ai' })
    await patched.it.status()
    await vi.waitFor(() => { expect(patched.pushed).toHaveLength(1) })
    expect(await patched.it.probe()).toEqual(patched.pushed[0])
    expect(calls()).toBe('auth status --json\n')
  })

  it('creates a session in the mode session/new names in its _meta', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-claude-acp-patch-'))
    const dist = path.join(fs.realpathSync(ADAPTER), 'dist')
    fs.symlinkSync(path.resolve(dist, '../../..'), path.join(dir, 'node_modules'))
    const source = fs.readFileSync(path.join(dist, 'v1', 'acp-agent.js'), 'utf8')
    const patched = patchClaudeAgentAcp(source, 'v1/acp-agent.js')
    expect(patchClaudeAgentAcp(patched, 'v1/acp-agent.js')).toBe(patched)
    const base = pathToFileURL(dist).href
    fs.writeFileSync(path.join(dir, 'patched.mjs'), patched
      .replaceAll('from "../', `from "${base}/`).replaceAll('from "./', `from "${base}/v1/`))

    // `newSession` on an agent whose `createSession` only records what it
    // was asked for: the adapter checks and applies a starting mode there.
    const modeAsked = async (file: string): Promise<unknown> => {
      const { ClaudeAcpAgent } = await import(pathToFileURL(file).href) as {
        ClaudeAcpAgent: { prototype: { newSession(params: object): Promise<unknown> } }
      }
      const asked: Array<{ permissionMode?: unknown }> = []
      const agent = Object.assign(Object.create(ClaudeAcpAgent.prototype) as typeof ClaudeAcpAgent.prototype, {
        createSession: (_request: object, opts: { permissionMode?: unknown }) => {
          asked.push(opts)
          return Promise.resolve({ sessionId: 's1' })
        },
        afterSetupResponse() {},
      })
      await agent.newSession({
        cwd: '/workspace', mcpServers: [], _meta: { claudeCode: { options: { permissionMode: 'bypassPermissions' } } },
      })
      return asked[0]?.permissionMode
    }
    expect(await modeAsked(path.join(dist, 'v1', 'acp-agent.js'))).toBeUndefined()
    expect(await modeAsked(path.join(dir, 'patched.mjs'))).toBe('bypassPermissions')
  })
})
