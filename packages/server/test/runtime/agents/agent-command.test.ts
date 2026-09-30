import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildAgentCmd,
  buildPromptPasteCmd,
  buildPromptPasteBgCmd,
  buildAgentWindowCheck,
  verifyAgentWindowAlive,
  AgentLaunchDeadError,
  initWindowCommand,
  OPENCODE_ACTIONS,
} from '#runtime/agents/agent-command'
import { PI_DEFAULT_PROVIDER, piProviderInfo } from '@yaac/shared/tool-providers'
import { AGENT_TOOLS, type AgentTool, type PermissionMode } from '@yaac/shared/types'

import { installFakeWorkspaceDriver, workspacePathsFixture } from '@yaac/test-utils/fake-driver'
import { WorkspaceExecError, type WorkspaceDriver } from '#drivers/contract'

interface OpencodeConfig {
  model?: string
  default_agent?: string
  permissions?: Array<{ action: string; resource: string; effect: string }>
}

/** The config document an opencode launch carries in OPENCODE_CONFIG_CONTENT. */
function opencodeConfigOf(cmd: string): OpencodeConfig {
  const json = /OPENCODE_CONFIG_CONTENT="(\{.*\})" opencode /.exec(cmd)?.[1]
  return JSON.parse((json ?? '{}').replace(/\\"/g, '"')) as OpencodeConfig
}

// In-pod paths; a containerless workspace gets its own.
const PATHS = workspacePathsFixture()
const TMUX = `tmux -S ${PATHS.tmuxSock}`

// Mock the driver's exec. The real WorkspaceExecError class is used because
// `verifyAgentWindowAlive` branches on it.
const podExec = vi.fn<WorkspaceDriver['exec']>()
  .mockResolvedValue({ stdout: '', stderr: '' })
beforeEach(() => { installFakeWorkspaceDriver({ exec: podExec }) })

describe('buildAgentCmd', () => {
  describe('codex tool', () => {
    // The command without its `-c` settings (pinned by the argv case below).
    const bare = (cmd: string): string => cmd.replace(/ -c "(?:[^"\\]|\\.)*"/g, '')

    it('omits prompt arguments', () => {
      const cmd = buildAgentCmd({ tool: 'codex', workspaceId: 'sess-1', permissionMode: 'bypass' })
      expect(bare(cmd)).toBe('codex --dangerously-bypass-hook-trust --yolo')
    })

    it('resumes the conversation it is given', () => {
      const cmd = buildAgentCmd({ tool: 'codex', workspaceId: 'sess-1', resume: true, permissionMode: 'bypass' })
      expect(bare(cmd)).toBe('codex --dangerously-bypass-hook-trust --yolo resume sess-1')
    })

    it('runs codex in the workspace, trusts the repository, and opens no startup screen', () => {
      // Run the command with `codex` replaced by an argv printer.
      const cmd = buildAgentCmd({
        tool: 'codex',
        workspaceId: 'sess-1',
        permissionMode: 'accept-edits',
        paths: { workspaceDir: '/data/wt' },
      })
      const argv = execFileSync('sh', ['-c', cmd.replace(/^codex /, `printf '%s\\n' `)], {
        env: { ...process.env, CODEX_HOME: '/must/not/expand' },
      }).toString().trimEnd().split('\n')
      expect(argv).toEqual([
        // Explicit, so a resume never asks which directory to use.
        '-C', '/data/wt',
        // yaac learns of a `/model` change from the title's last segment.
        '-c', 'tui.terminal_title=["activity","project-name","model"]',
        // Otherwise an outdated codex opens an "Update available" screen.
        '-c', 'check_for_update_on_startup=false',
        // Trust the folder and run yaac's hooks without asking, so no startup
        // screen swallows the pasted prompt.
        '-c', 'projects={"/data/wt"={trust_level="trusted"}}',
        '--dangerously-bypass-hook-trust',
      ])
    })

    it('inserts --model when a model override is given', () => {
      const cmd = buildAgentCmd({ tool: 'codex', workspaceId: 'sess-1', resume: false, model: 'gpt-5.2-codex', permissionMode: 'bypass' })
      expect(bare(cmd)).toBe('codex --dangerously-bypass-hook-trust --yolo --model gpt-5.2-codex')
    })

    it('places --model after the resume subcommand (codex resume parses it)', () => {
      const cmd = buildAgentCmd({ tool: 'codex', workspaceId: 'abc', resume: true, model: 'gpt-5.2-codex', permissionMode: 'bypass' })
      expect(cmd).toMatch(/ --yolo resume abc --model gpt-5\.2-codex$/)
    })
  })

  describe('opencode tool', () => {
    // The permission posture is in OPENCODE_CONFIG_CONTENT (tested below).
    it('runs the TUI over a private server of its own', () => {
      const cmd = buildAgentCmd({ tool: 'opencode', workspaceId: 'sess-1', permissionMode: 'bypass' })
      expect(cmd).toMatch(/ opencode --standalone$/)
    })

    it('resumes a session by id', () => {
      const cmd = buildAgentCmd({ tool: 'opencode', workspaceId: 'ses_1', resume: true, permissionMode: 'bypass' })
      expect(cmd).toMatch(/^OPENCODE_CONFIG_CONTENT=.* opencode --standalone --session ses_1$/)
    })

    it('carries a provider/model override in the config, never as a flag', () => {
      // The TUI has no --model flag and refuses unknown flags.
      const cmd = buildAgentCmd({ tool: 'opencode', workspaceId: 'sess-1', resume: false, model: 'anthropic/claude-opus-4-8', permissionMode: 'bypass' })
      expect(cmd).not.toContain('--model')
      expect(opencodeConfigOf(cmd).model).toBe('anthropic/claude-opus-4-8')
    })
  })

  describe('pi tool', () => {
    const defaultModel = piProviderInfo(PI_DEFAULT_PROVIDER).defaultModel
    const anthropicModel = piProviderInfo('anthropic').defaultModel

    // pi's stderr goes through sed to drop the first "Warning: No project
    // session found with id ..." line, including any leading color codes.
    const wrapped = (piCmd: string) =>
      `${piCmd} 2> >(sed -u -E "0,/^(\\x1b\\[[0-9;]*m)*Warning: No project session found with id .*creating a new session with that id\\./{//d}" >&2)`

    it('uses --approve, the default provider model, and --session-id when none is given', () => {
      const cmd = buildAgentCmd({ tool: 'pi', workspaceId: 'sess-1', permissionMode: 'bypass' })
      expect(cmd).toBe(wrapped(`pi --approve --model ${defaultModel} --session-id sess-1`))
    })

    it('uses the given provider default model', () => {
      const cmd = buildAgentCmd({ tool: 'pi', workspaceId: 'sess-1', resume: false, piProvider: 'anthropic', permissionMode: 'bypass' })
      expect(cmd).toBe(wrapped(`pi --approve --model ${anthropicModel} --session-id sess-1`))
    })

    it('addresses the session by id when resuming (same command as create)', () => {
      const cmd = buildAgentCmd({ tool: 'pi', workspaceId: 'sess-1', resume: true, piProvider: 'anthropic', permissionMode: 'bypass' })
      expect(cmd).toBe(wrapped(`pi --approve --model ${anthropicModel} --session-id sess-1`))
    })

    it('prefers an explicit model override over the provider default', () => {
      const cmd = buildAgentCmd({ tool: 'pi', workspaceId: 'sess-1', resume: false, piProvider: 'anthropic', model: 'openai/gpt-5.2', permissionMode: 'bypass' })
      expect(cmd).toBe(wrapped('pi --approve --model openai/gpt-5.2 --session-id sess-1'))
    })

    it('filters the fresh-run warning without single quotes (survives respawn wrapper)', () => {
      const cmd = buildAgentCmd({ tool: 'pi', workspaceId: 'sess-1', permissionMode: 'bypass' })
      // No single quotes: the command is embedded in `respawn-window '<cmd>'`.
      expect(cmd).not.toContain("'")
      // Anchored at line start, and only the first match is deleted.
      expect(cmd).toContain('2> >(sed -u -E "0,/^(\\x1b\\[[0-9;]*m)*Warning: ')
      expect(cmd).toContain('creating a new session with that id\\./{//d}" >&2)')
    })
  })

  describe('claude tool', () => {
    // claude animates its title (the pane's status signal) only when `$TMUX`
    // is unset, so every claude launch below must include `env -u TMUX`.
    it('hides $TMUX so the title keeps animating, and omits prompt flags', () => {
      const cmd = buildAgentCmd({ tool: 'claude', workspaceId: 'sess-1', permissionMode: 'bypass' })
      expect(cmd).toBe('env -u TMUX YAAC_TMUX="$TMUX" CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --session-id sess-1')
    })

    it('swaps --session-id for --resume when resuming', () => {
      const cmd = buildAgentCmd({ tool: 'claude', workspaceId: 'sess-1', resume: true, permissionMode: 'bypass' })
      expect(cmd).toBe('env -u TMUX YAAC_TMUX="$TMUX" CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --resume sess-1')
    })

    it('inserts --model when a model override is given', () => {
      const cmd = buildAgentCmd({ tool: 'claude', workspaceId: 'sess-1', resume: false, model: 'claude-opus-4-8', permissionMode: 'bypass' })
      expect(cmd).toBe('env -u TMUX YAAC_TMUX="$TMUX" CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --model claude-opus-4-8 --session-id sess-1')
    })

    it('combines a model override with resume', () => {
      const cmd = buildAgentCmd({ tool: 'claude', workspaceId: 'sess-1', resume: true, model: 'opus', permissionMode: 'bypass' })
      expect(cmd).toBe('env -u TMUX YAAC_TMUX="$TMUX" CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --model opus --resume sess-1')
    })
  })

  // Each tool expresses postures differently, so every (tool, posture) pair
  // is asserted. `accept-edits` is codex's default, so it adds no flag.
  describe('permission modes', () => {
    const CASES: [AgentTool, PermissionMode, string][] = [
      ['claude', 'bypass', 'claude --permission-mode bypassPermissions'],
      ['claude', 'auto', 'claude --permission-mode auto'],
      ['claude', 'accept-edits', 'claude --permission-mode acceptEdits'],
      ['claude', 'plan', 'claude --permission-mode plan'],
      ['claude', 'manual', 'claude --permission-mode manual'],
      ['codex', 'bypass', ' --yolo'],
      ['codex', 'auto', ' --approve-for-me'],
      ['codex', 'accept-edits', 'codex'],
      ['codex', 'plan', ' --sandbox read-only'],
    ]

    it.each(CASES)('%s in %s mode', (tool, permissionMode, expected) => {
      expect(buildAgentCmd({ tool, workspaceId: 'sess-1', permissionMode })).toContain(expected)
    })

    // opencode's base policy starts with `* allow` and ignores unknown
    // actions, so a misspelled rule silently allows everything. Hence exact
    // assertions. There is no posture flag; the TUI would refuse one.
    it('spells every opencode posture in rules opencode actually reads', () => {
      const postureOf = (permissionMode: PermissionMode): OpencodeConfig => {
        const cmd = buildAgentCmd({ tool: 'opencode', workspaceId: 's', permissionMode })
        // Escaped double quotes only: the command is embedded in
        // `respawn-window '<cmd>'`, and bare braces would be expanded by zsh.
        expect(cmd).not.toContain("'")
        expect(cmd).not.toContain('--auto')
        expect(cmd).not.toContain('--agent')
        return opencodeConfigOf(cmd)
      }
      const rule = (action: string, effect: string) => ({ action, resource: '*', effect })

      // Bypass explicitly allows everything; the base policy would still ask
      // for some things.
      expect(postureOf('bypass')).toEqual({ permissions: [rule('*', 'allow')] })
      // Manual asks before any action (wildcard first, to cover tools the base
      // policy allows), then re-allows reads and restates the .env asks.
      const askToAct = [
        rule('*', 'ask'),
        rule('read', 'allow'), rule('glob', 'allow'), rule('grep', 'allow'), rule('question', 'allow'),
        { action: 'read', resource: '*.env', effect: 'ask' },
        { action: 'read', resource: '*.env.*', effect: 'ask' },
      ]
      expect(postureOf('manual')).toEqual({ permissions: askToAct })
      // Accept-edits also allows `edit` (which covers edit, write and patch).
      expect(postureOf('accept-edits')).toEqual({ permissions: [...askToAct, rule('edit', 'allow')] })
      // Plan uses opencode's plan agent, plus the same rules since that agent
      // would otherwise run commands unprompted.
      expect(postureOf('plan')).toEqual({ default_agent: 'plan', permissions: askToAct })
    })

    // opencode silently ignores unknown actions, so check every name against
    // the pinned binary's list.
    it('names only actions the pinned opencode binary knows', () => {
      for (const mode of ['bypass', 'accept-edits', 'manual', 'plan'] as const) {
        const cmd = buildAgentCmd({ tool: 'opencode', workspaceId: 's', permissionMode: mode })
        for (const r of opencodeConfigOf(cmd).permissions ?? []) {
          expect(OPENCODE_ACTIONS).toContain(r.action)
        }
      }
    })

    // Run through a real shell: config opencode cannot parse fails open.
    it('delivers the opencode posture through the shell it is embedded in', () => {
      const cmd = buildAgentCmd({ tool: 'opencode', workspaceId: 's', permissionMode: 'manual' })
      const env = /^(OPENCODE_CONFIG_CONTENT=\S+)/.exec(cmd)?.[1] ?? ''
      const out = execFileSync('sh', ['-c', `${env} printenv OPENCODE_CONFIG_CONTENT`], { encoding: 'utf8' })
      expect(JSON.parse(out) as OpencodeConfig).toEqual(opencodeConfigOf(cmd))
    })

    // A workspace row may name a posture the tool lacks. Each falls back to
    // the loosest posture the tool has that is no looser than the row's.
    it('falls back to the nearest posture a tool actually has', () => {
      // pi has no permission system, so every posture is effectively bypass.
      const piManual = buildAgentCmd({ tool: 'pi', workspaceId: 's', permissionMode: 'manual' })
      expect(piManual).toBe(buildAgentCmd({ tool: 'pi', workspaceId: 's', permissionMode: 'bypass' }))
      expect(piManual).toContain('pi --approve')
      // opencode has no reviewer model, so `auto` becomes accept-edits.
      expect(buildAgentCmd({ tool: 'opencode', workspaceId: 's', permissionMode: 'auto' }))
        .toBe(buildAgentCmd({ tool: 'opencode', workspaceId: 's', permissionMode: 'accept-edits' }))
      // The pinned codex has no `manual`, so it falls back to read-only (plan).
      expect(buildAgentCmd({ tool: 'codex', workspaceId: 's', permissionMode: 'manual' }))
        .toBe(buildAgentCmd({ tool: 'codex', workspaceId: 's', permissionMode: 'plan' }))
      // An unknown posture gets the tool's strictest.
      expect(buildAgentCmd({ tool: 'claude', workspaceId: 's', permissionMode: 'dontAsk' as PermissionMode }))
        .toContain('--permission-mode plan')
    })
  })
})

/** Pull the paste's base64 payload back out of the generated command. */
function embeddedPrompt(cmd: string): string {
  const match = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| tmux[^|]*load-buffer/.exec(cmd)
  expect(match).not.toBeNull()
  return Buffer.from(match![1], 'base64').toString('utf8')
}

describe('buildPromptPasteCmd', () => {
  it('round-trips arbitrary prompt text through the base64 payload', () => {
    const nasty = 'say "hi" && don\'t eval `$HOME`\nsecond line — ünïcode'
    expect(embeddedPrompt(buildPromptPasteCmd('yaac:claude', nasty, PATHS))).toBe(nasty)
  })

  it('never embeds the raw prompt, and stays single-quote-clean for the host shell', () => {
    const nasty = "it's $HOME; \"quoted\""
    const cmd = buildPromptPasteCmd('yaac:claude', nasty, PATHS)
    expect(cmd).not.toContain('$HOME')
    // The only single quotes are the outer `sh -c` wrapper's.
    expect(cmd.startsWith("sh -c '")).toBe(true)
    expect(cmd.endsWith("'")).toBe(true)
    expect(cmd.slice("sh -c '".length, -1)).not.toContain("'")
  })

  it.each(AGENT_TOOLS)('targets the %s agent window', (tool) => {
    const cmd = buildPromptPasteCmd(`yaac:${tool}`, 'prompt', PATHS)
    expect(cmd).toContain(`paste-buffer -p -d -b yaac-prompt -t yaac:${tool}`)
    expect(cmd).toContain(`send-keys -t yaac:${tool} Enter`)
  })

  describe('against a stub tmux', () => {
    let bin: string

    /**
     * How the stub pane renders a paste:
     * - `text`: verbatim, like a wide input box.
     * - `claude`: tabs and CRs as spaces, wrapped at 7 columns, only the
     *   last 6 rows visible, like claude's input box in a small window.
     * - `marker`: a collapsed-paste placeholder, as pi and codex show a
     *   long paste.
     * - `none`: nothing, like a dialog that swallows the keys.
     */
    type Render = 'text' | 'claude' | 'marker' | 'none'

    /** Run the script with `tmux` and `sleep` stubbed on PATH. Returns the
     *  exit status and every tmux command that changed the pane. */
    function runScript(render: Render, prompt = 'hello there'): { status: number; calls: string[] } {
      const cmd = buildPromptPasteCmd('yaac:claude', prompt, PATHS)
      fs.writeFileSync(path.join(bin, 'calls'), '')
      fs.rmSync(path.join(bin, 'screen'), { force: true })
      const res = spawnSync('sh', ['-c', cmd], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB: bin, RENDER: render },
      })
      const calls = fs.readFileSync(path.join(bin, 'calls'), 'utf8').trim().split('\n')
      return { status: res.status ?? -1, calls }
    }

    beforeEach(() => {
      bin = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-paste-'))
      fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\n', { mode: 0o755 })
      fs.writeFileSync(path.join(bin, 'tmux'), [
        '#!/bin/sh',
        'shift 2',
        'case "$1" in',
        '  display) echo 1 ;;',
        '  capture-pane) cat "$STUB/screen" 2>/dev/null ;;',
        '  load-buffer) cat > "$STUB/buffer" ;;',
        '  paste-buffer)',
        '    echo paste >> "$STUB/calls"',
        '    case "$RENDER" in',
        '      text) cat "$STUB/buffer" > "$STUB/screen" ;;',
        '      claude) tr "\\t\\r" "  " < "$STUB/buffer" | fold -w 7 | tail -n 6 > "$STUB/screen" ;;',
        '      marker) echo "> [paste #1 +13 lines]" > "$STUB/screen" ;;',
        '    esac ;;',
        '  send-keys) echo "send-keys $4" >> "$STUB/calls" ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'), { mode: 0o755 })
    })

    afterEach(() => {
      fs.rmSync(bin, { recursive: true, force: true })
    })

    const submitted = { status: 0, calls: ['paste', 'send-keys Enter', 'send-keys Enter'] }

    it('submits once the paste shows in the pane, with a guard resend', () => {
      expect(runScript('text')).toEqual(submitted)
    })

    it('recognizes the paste however the TUI wraps, scrolls or collapses it', () => {
      // CRLF endings, wrapped lines, and a first line that scrolls out of
      // view, so only the last-20 probe can match under `claude`.
      const prompt = `Please\tfix the flaky login test todayxx\u{1F642} now\r\n${'more detail\r\n'.repeat(8)}thanks`
      expect(runScript('claude', prompt)).toEqual(submitted)
      expect(runScript('marker', prompt)).toEqual(submitted)
    })

    it('matches probes that hold a tab and an emoji at their edge', () => {
      // 19 visible characters on each side of the emoji, so the first-20
      // and last-20 probes both reach it; a UTF-16 slice would cut it in
      // half in both.
      expect(runScript('claude', 'Please\tfix the flakyyy\u{1F642} login test is red today')).toEqual(submitted)
    })

    it('never presses Enter on a pane that does not show the paste', () => {
      // A startup dialog (claude's folder trust) swallows the paste, and
      // Enter there would pick its preselected "No, exit".
      const { status, calls } = runScript('none')
      expect(status).toBe(1)
      expect(calls).toEqual(Array<string>(10).fill('paste'))
    })
  })

  it('degrades to a single blind paste for a whitespace-only prompt', () => {
    const cmd = buildPromptPasteCmd('yaac:claude', ' \n ', PATHS)
    expect(cmd).not.toContain('head=')
    expect(cmd).toContain('paste-buffer -p -d -b yaac-prompt -t yaac:claude')
  })
})

describe('buildPromptPasteBgCmd', () => {
  it('decodes the paste script to a pod file and detaches it with setsid', () => {
    const cmd = buildPromptPasteBgCmd('yaac:claude', 'hello', PATHS)
    expect(cmd).toMatch(/^printf %s [A-Za-z0-9+/=]+ \| base64 -d > \/tmp\/\.yaac-prompt\.sh/)
    expect(cmd).toContain('setsid sh /tmp/.yaac-prompt.sh >/tmp/yaac-prompt.log 2>&1 </dev/null &')
  })

  it('embeds exactly the script buildPromptPasteCmd wraps', () => {
    const cmd = buildPromptPasteBgCmd('yaac:codex', "it's $HOME\nline 2", PATHS)
    const b64 = /^printf %s ([A-Za-z0-9+/=]+) \|/.exec(cmd)
    expect(b64).not.toBeNull()
    const script = Buffer.from(b64![1], 'base64').toString('utf8')
    expect(`sh -c '${script}'`).toBe(buildPromptPasteCmd('yaac:codex', "it's $HOME\nline 2", PATHS))
  })
})

describe('buildAgentWindowCheck', () => {
  it('probes for the agent window after a settle delay', () => {
    // respawn-window succeeds even if the command dies at once, so wait first.
    const cmd = buildAgentWindowCheck(['claude'], PATHS)
    expect(cmd).toContain('sleep 1;')
    expect(cmd).toContain(`names=\\$(${TMUX} list-windows -t =yaac -F '#{window_name}')`)
    expect(cmd).toContain('grep -qxF claude')
  })

  it('checks every window a multi-agent launch asked for, in one probe', () => {
    // One exit code for all windows; each missing name is echoed.
    const cmd = buildAgentWindowCheck(['claude', 'claude-2', 'codex'], PATHS)
    for (const w of ['claude', 'claude-2', 'codex']) {
      expect(cmd).toContain(`grep -qxF ${w} || { echo ${w} >&2; rc=1; }`)
    }
    expect(cmd.match(/list-windows/g)).toHaveLength(1)
    expect(cmd.match(/sleep 1/g)).toHaveLength(1)
    expect(cmd.endsWith('exit \\$rc"')).toBe(true)
  })

  it('fails the probe when tmux itself is gone, rather than reading no windows as no agents', () => {
    // A dead tmux server must not look like missing windows.
    expect(buildAgentWindowCheck(['claude'], PATHS)).toContain("#{window_name}') || exit 1")
  })
})

describe('verifyAgentWindowAlive', () => {
  // No `mockClear()` here: clearing a spy that returned a promise makes
  // vitest report a later rejection as unhandled. Each case sets its own
  // implementation instead.
  it('relay-execs the window probe and passes when it exits 0', async () => {
    podExec.mockImplementation(() => Promise.resolve({ stdout: '', stderr: '' }))
    await expect(verifyAgentWindowAlive('yaac-job-1', ['codex'])).resolves.toBeUndefined()
    // Compare the first two args; the call also carries an undefined opts.
    expect(podExec.mock.calls.at(-1)?.slice(0, 2))
      .toEqual(['yaac-job-1', buildAgentWindowCheck(['codex'], PATHS)])
  })

  it('reports a missing window as a dead agent when the probe ran in the pod', async () => {
    podExec.mockImplementation(
      () => Promise.reject(new WorkspaceExecError('command exited 1', 1, '', 'no server running on /tmp/yaac.sock')),
    )
    // stderr must reach the message; it distinguishes a dead tmux server.
    await expect(verifyAgentWindowAlive('yaac-job-1', ['codex']))
      .rejects.toThrow(/agent "codex" exited right after launch.*no server running/s)
  })

  it('names every window it was asked about when several agents were launched', async () => {
    podExec.mockImplementation(
      () => Promise.reject(new WorkspaceExecError('command exited 1', 1, '', 'claude-2')),
    )
    await expect(verifyAgentWindowAlive('yaac-job-1', ['claude', 'claude-2']))
      .rejects.toThrow(/agents claude, claude-2 exited right after launch/)
  })

  it('propagates a transport failure instead of blaming the agent', async () => {
    // The probe never reached the pod, so it says nothing about the agent.
    podExec.mockImplementation(
      () => Promise.reject(new Error('stream relay dial: timeout')),
    )
    await expect(verifyAgentWindowAlive('yaac-job-1', ['codex']))
      .rejects.toThrow('stream relay dial: timeout')
  })

  it('types the verdict, so a caller that cannot rethrow still tells the two apart', async () => {
    // Create runs this probe without awaiting it, so its rejection handler
    // needs the error type to tell a transport blip from a dead agent.
    podExec.mockImplementation(
      () => Promise.reject(new WorkspaceExecError('command exited 1', 1, '', 'codex')),
    )
    await expect(verifyAgentWindowAlive('yaac-job-1', ['codex']))
      .rejects.toBeInstanceOf(AgentLaunchDeadError)

    podExec.mockImplementation(() => Promise.reject(new Error('stream relay dial: timeout')))
    const transport = await verifyAgentWindowAlive('yaac-job-1', ['codex']).catch((e: unknown) => e)
    expect(transport).not.toBeInstanceOf(AgentLaunchDeadError)
  })
})

describe('initWindowCommand', () => {
  it('creates a visible window with remain-on-exit chained on', () => {
    const cmd = initWindowCommand({ name: 'init', cmd: 'pnpm install', hidePane: false }, PATHS)
    expect(cmd).toBe(
      `${TMUX} new-window -d -t yaac -n init 'cd /workspace && pnpm install'`
      + ' \\; set-option -t yaac:init remain-on-exit on',
    )
  })

  it('omits remain-on-exit for hidden panes', () => {
    const cmd = initWindowCommand({ name: 'deps', cmd: 'pnpm install', hidePane: true }, PATHS)
    expect(cmd).toBe(`${TMUX} new-window -d -t yaac -n deps 'cd /workspace && pnpm install'`)
  })
})
