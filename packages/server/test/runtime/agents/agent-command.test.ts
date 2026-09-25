import { execFileSync } from 'node:child_process'
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

import { installFakeWorktreeDriver, workspacePathsFixture } from '@yaac/test-utils/fake-driver'
import { WorkspaceExecError, type WorktreeDriver } from '#drivers/contract'

interface OpencodeConfig {
  model?: string
  default_agent?: string
  permissions?: Array<{ action: string; resource: string; effect: string }>
  plugins?: string[]
}

/** The config document an opencode launch carries in OPENCODE_CONFIG_CONTENT. */
function opencodeConfigOf(cmd: string): OpencodeConfig {
  const json = /OPENCODE_CONFIG_CONTENT="(\{.*\})" opencode /.exec(cmd)?.[1]
  return JSON.parse((json ?? '{}').replace(/\\"/g, '"')) as OpencodeConfig
}

// The container paths every case below is written against; the driver
// answers these for a pod, and a containerless workspace gets its own.
const PATHS = workspacePathsFixture()
const TMUX = `tmux -S ${PATHS.tmuxSock}`

// Mocked at the contract boundary. `verifyAgentWindowAlive` branches on
// WorkspaceExecError to tell "the probe ran and the window is gone" apart
// from "the workspace was never reached", so the real class is used.
const podExec = vi.fn<WorktreeDriver['exec']>()
  .mockResolvedValue({ stdout: '', stderr: '' })
beforeEach(() => { installFakeWorktreeDriver({ exec: podExec }) })

describe('buildAgentCmd', () => {
  describe('codex tool', () => {
    // The title items are how a `/model` reaches yaac: codex rewrites its
    // title's last segment the moment one lands. Double-quoted with escaped
    // inner quotes, so the TOML array survives the single-quoted wrapper.
    const TITLE = '-c "tui.terminal_title=[\\"activity\\",\\"project-name\\",\\"model\\"]"'

    it('omits prompt arguments', () => {
      const cmd = buildAgentCmd({ tool: 'codex', worktreeId: 'sess-1', permissionMode: 'bypass' })
      expect(cmd).toBe(`codex ${TITLE} --yolo`)
    })

    it('inserts the resume subcommand when resuming', () => {
      const cmd = buildAgentCmd({ tool: 'codex', worktreeId: 'sess-1', resume: true, permissionMode: 'bypass' })
      expect(cmd).toBe(`codex ${TITLE} --yolo resume sess-1`)
    })

    it('inserts --model when a model override is given', () => {
      const cmd = buildAgentCmd({ tool: 'codex', worktreeId: 'sess-1', resume: false, model: 'gpt-5.2-codex', permissionMode: 'bypass' })
      expect(cmd).toBe(`codex ${TITLE} --yolo --model gpt-5.2-codex`)
    })

    it('places --model after the resume subcommand (codex resume parses it)', () => {
      const cmd = buildAgentCmd({ tool: 'codex', worktreeId: 'abc', resume: true, model: 'gpt-5.2-codex', permissionMode: 'bypass' })
      expect(cmd).toBe(`codex ${TITLE} --yolo resume abc --model gpt-5.2-codex`)
    })
  })

  describe('opencode tool', () => {
    // The posture rides in OPENCODE_CONFIG_CONTENT (asserted below); these
    // cases are about the launch itself.
    it('runs the TUI over a private server of its own', () => {
      const cmd = buildAgentCmd({ tool: 'opencode', worktreeId: 'sess-1', permissionMode: 'bypass' })
      expect(cmd).toMatch(/ opencode --standalone$/)
    })

    it('appends --continue when resuming', () => {
      const cmd = buildAgentCmd({ tool: 'opencode', worktreeId: 'sess-1', resume: true, permissionMode: 'bypass' })
      expect(cmd).toMatch(/ opencode --standalone --continue$/)
    })

    it('carries a provider/model override in the config, never as a flag', () => {
      // The TUI has no --model flag and refuses an unknown one outright.
      const cmd = buildAgentCmd({ tool: 'opencode', worktreeId: 'sess-1', resume: false, model: 'anthropic/claude-opus-4-8', permissionMode: 'bypass' })
      expect(cmd).not.toContain('--model')
      expect(opencodeConfigOf(cmd).model).toBe('anthropic/claude-opus-4-8')
    })
  })

  describe('pi tool', () => {
    const defaultModel = piProviderInfo(PI_DEFAULT_PROVIDER).defaultModel
    const anthropicModel = piProviderInfo('anthropic').defaultModel

    // pi's command routes stderr through sed so the first line matching its
    // fresh-run "Warning: No project session found with id ..." warning is
    // dropped from the pane. On a PTY pi color-wraps the line, so the leading
    // `(\x1b\[[0-9;]*m)*` absorbs the SGR escapes (see buildAgentCmd).
    const wrapped = (piCmd: string) =>
      `${piCmd} 2> >(sed -u -E "0,/^(\\x1b\\[[0-9;]*m)*Warning: No project session found with id .*creating a new session with that id\\./{//d}" >&2)`

    it('uses --approve, the default provider model, and --session-id when none is given', () => {
      const cmd = buildAgentCmd({ tool: 'pi', worktreeId: 'sess-1', permissionMode: 'bypass' })
      expect(cmd).toBe(wrapped(`pi --approve --model ${defaultModel} --session-id sess-1`))
    })

    it('uses the given provider default model', () => {
      const cmd = buildAgentCmd({ tool: 'pi', worktreeId: 'sess-1', resume: false, piProvider: 'anthropic', permissionMode: 'bypass' })
      expect(cmd).toBe(wrapped(`pi --approve --model ${anthropicModel} --session-id sess-1`))
    })

    it('addresses the session by id when resuming (same command as create)', () => {
      const cmd = buildAgentCmd({ tool: 'pi', worktreeId: 'sess-1', resume: true, piProvider: 'anthropic', permissionMode: 'bypass' })
      expect(cmd).toBe(wrapped(`pi --approve --model ${anthropicModel} --session-id sess-1`))
    })

    it('prefers an explicit model override over the provider default', () => {
      const cmd = buildAgentCmd({ tool: 'pi', worktreeId: 'sess-1', resume: false, piProvider: 'anthropic', model: 'openai/gpt-5.2', permissionMode: 'bypass' })
      expect(cmd).toBe(wrapped('pi --approve --model openai/gpt-5.2 --session-id sess-1'))
    })

    it('filters the fresh-run warning without single quotes (survives respawn wrapper)', () => {
      const cmd = buildAgentCmd({ tool: 'pi', worktreeId: 'sess-1', permissionMode: 'bypass' })
      // Must never contain a single quote: it is embedded in tmux
      // `respawn-window '<cmd>'`, itself passed through the host `sh -c`. The
      // sed pattern uses `.*` instead of the literal quotes around the id so
      // the whole command stays single-quote-free.
      expect(cmd).not.toContain("'")
      // Anchored at `^` (after any leading SGR color codes pi adds on a PTY) so
      // a genuine error is never swallowed, and `0,/re/{//d}` deletes only the
      // first occurrence.
      expect(cmd).toContain('2> >(sed -u -E "0,/^(\\x1b\\[[0-9;]*m)*Warning: ')
      expect(cmd).toContain('creating a new session with that id\\./{//d}" >&2)')
    })
  })

  describe('claude tool', () => {
    // `env -u TMUX` is load-bearing, not cosmetic: claude animates the spinner
    // into its title only when it cannot see `$TMUX`, and that title is the
    // whole status signal for a claude pane. If this prefix is dropped, every
    // claude worktree reads `waiting` forever and nothing fails — so it is
    // asserted on every claude launch shape below, not just once.
    it('hides $TMUX so the title keeps animating, and omits prompt flags', () => {
      const cmd = buildAgentCmd({ tool: 'claude', worktreeId: 'sess-1', permissionMode: 'bypass' })
      expect(cmd).toBe('env -u TMUX YAAC_TMUX="$TMUX" CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --session-id sess-1')
    })

    it('swaps --session-id for --resume when resuming', () => {
      const cmd = buildAgentCmd({ tool: 'claude', worktreeId: 'sess-1', resume: true, permissionMode: 'bypass' })
      expect(cmd).toBe('env -u TMUX YAAC_TMUX="$TMUX" CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --resume sess-1')
    })

    it('inserts --model when a model override is given', () => {
      const cmd = buildAgentCmd({ tool: 'claude', worktreeId: 'sess-1', resume: false, model: 'claude-opus-4-8', permissionMode: 'bypass' })
      expect(cmd).toBe('env -u TMUX YAAC_TMUX="$TMUX" CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --model claude-opus-4-8 --session-id sess-1')
    })

    it('combines a model override with resume', () => {
      const cmd = buildAgentCmd({ tool: 'claude', worktreeId: 'sess-1', resume: true, model: 'opus', permissionMode: 'bypass' })
      expect(cmd).toBe('env -u TMUX YAAC_TMUX="$TMUX" CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --model opus --resume sess-1')
    })
  })

  // Every tool spells the posture differently — a flag for claude, an
  // approval/sandbox pair for codex, config for opencode, nothing at all for
  // pi — so the mapping is asserted per (tool, posture) rather than trusted
  // to read correctly. `accept-edits` is codex's own default preset, which is
  // why its expectation carries no posture flag.
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
      expect(buildAgentCmd({ tool, worktreeId: 'sess-1', permissionMode })).toContain(expected)
    })

    // opencode's rules are appended over a base policy whose first rule is
    // `* allow`, and an action it does not know matches nothing — so a
    // posture spelled in the wrong action is not a partial posture but no
    // posture, and it fails open, silently, on the user's real filesystem.
    // The assertions are exact for that reason. There is deliberately no
    // posture flag — opencode's TUI has none, and refuses an unknown one
    // outright, which would leave a dead window.
    it('spells every opencode posture in rules opencode actually reads', () => {
      const postureOf = (permissionMode: PermissionMode): OpencodeConfig => {
        const cmd = buildAgentCmd({ tool: 'opencode', worktreeId: 's', permissionMode })
        // Escaped double quotes, never single ones: the whole command is
        // embedded in `respawn-window '<cmd>'`, and bare braces would hit zsh
        // brace expansion before opencode ever saw them.
        expect(cmd).not.toContain("'")
        expect(cmd).not.toContain('--auto')
        expect(cmd).not.toContain('--agent')
        // Every posture also loads yaac's model reporter.
        const { plugins, ...posture } = opencodeConfigOf(cmd)
        expect(plugins).toEqual(['$HOME/.config/opencode/yaac-report'])
        return posture
      }
      const rule = (action: string, effect: string) => ({ action, resource: '*', effect })

      // Bypass states allow-everything rather than inheriting opencode's base
      // policy, which already asks for out-of-tree access and .env reads: an
      // unstated bypass is not one.
      expect(postureOf('bypass')).toEqual({ permissions: [rule('*', 'allow')] })
      // Manual asks before anything that acts, wildcard first so what the
      // base policy allows without this file naming it (websearch, subagents,
      // skills, Code Mode, MCP tools) is covered; reads come back to allow,
      // with the base policy's .env asks restated behind that wildcard.
      const askToAct = [
        rule('*', 'ask'),
        rule('read', 'allow'), rule('glob', 'allow'), rule('grep', 'allow'), rule('question', 'allow'),
        { action: 'read', resource: '*.env', effect: 'ask' },
        { action: 'read', resource: '*.env.*', effect: 'ask' },
      ]
      expect(postureOf('manual')).toEqual({ permissions: askToAct })
      // Accept-edits is the same with editing let through, as claude's is —
      // `edit` is what the edit, write and patch tools all assert — while
      // commands, fetches, subagents, Code Mode and MCP tools still ask.
      expect(postureOf('accept-edits')).toEqual({ permissions: [...askToAct, rule('edit', 'allow')] })
      // Plan selects opencode's own plan agent for its `edit: deny`, and
      // carries the same rules because that agent says nothing about shell:
      // on its own it would run commands unprompted.
      expect(postureOf('plan')).toEqual({ default_agent: 'plan', permissions: askToAct })
    })

    // A rule naming an action opencode does not know is accepted with no
    // diagnostic and matches nothing, so the names are pinned against the
    // vocabulary read off the pinned binary rather than trusted to read right.
    it('names only actions the pinned opencode binary knows', () => {
      for (const mode of ['bypass', 'accept-edits', 'manual', 'plan'] as const) {
        const cmd = buildAgentCmd({ tool: 'opencode', worktreeId: 's', permissionMode: mode })
        for (const r of opencodeConfigOf(cmd).permissions ?? []) {
          expect(OPENCODE_ACTIONS).toContain(r.action)
        }
      }
    })

    // The escaping has to survive the real trip, which string equality above
    // cannot show: the command is embedded in a single-quoted
    // `respawn-window '<cmd>'` and then run by a shell, so a quote or brace
    // that does not survive leaves opencode reading a broken value — and a
    // config value opencode cannot parse fails OPEN.
    it('delivers the opencode posture through the shell it is embedded in', () => {
      const cmd = buildAgentCmd({ tool: 'opencode', worktreeId: 's', permissionMode: 'manual' })
      const env = /^(OPENCODE_CONFIG_CONTENT=\S+)/.exec(cmd)?.[1] ?? ''
      // Exactly how it travels: single-quoted inside the tmux argument, which
      // a shell then unwraps and runs.
      const out = execFileSync('sh', ['-c', `${env} printenv OPENCODE_CONFIG_CONTENT`], {
        encoding: 'utf8',
        env: { ...process.env, HOME: '/home/someone' },
      })
      // The plugin path is the one part the shell is meant to change: it
      // expands to the workspace's own opencode config home.
      expect(JSON.parse(out) as OpencodeConfig).toEqual({
        ...opencodeConfigOf(cmd),
        plugins: ['/home/someone/.config/opencode/yaac-report'],
      })
    })

    // A posture the tool does not have can still reach here off a worktree
    // row written by a different build. Refusing would strand the checkout,
    // so each falls back to the most permissive posture that tool really has
    // no looser than the row's.
    it('falls back to the nearest posture a tool actually has', () => {
      // pi has no permission system at all: every posture is bypass in fact,
      // and its command is the same one `bypass` produces.
      const piManual = buildAgentCmd({ tool: 'pi', worktreeId: 's', permissionMode: 'manual' })
      expect(piManual).toBe(buildAgentCmd({ tool: 'pi', worktreeId: 's', permissionMode: 'bypass' }))
      expect(piManual).toContain('pi --approve')
      // opencode has no reviewer model, so `auto` lands on accept-edits
      // rather than on the unrestrained `--auto` flag.
      expect(buildAgentCmd({ tool: 'opencode', worktreeId: 's', permissionMode: 'auto' }))
        .toBe(buildAgentCmd({ tool: 'opencode', worktreeId: 's', permissionMode: 'accept-edits' }))
      // codex's `manual` was the `untrusted` policy the pinned codex no longer
      // has, and the next stricter posture is its read-only sandbox — never
      // the unrestrained default a looser fallback would give.
      expect(buildAgentCmd({ tool: 'codex', worktreeId: 's', permissionMode: 'manual' }))
        .toBe(buildAgentCmd({ tool: 'codex', worktreeId: 's', permissionMode: 'plan' }))
      // A posture this build does not rank compares with nothing: the
      // tool's strictest, never the first one offered.
      expect(buildAgentCmd({ tool: 'claude', worktreeId: 's', permissionMode: 'dontAsk' as PermissionMode }))
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

  it('verifies the paste against the first line, capped at 40 columns', () => {
    const prompt = `${'x'.repeat(60)} tail\nsecond line`
    const cmd = buildPromptPasteCmd('yaac:claude', prompt, PATHS)
    const probe = /probe="\$\(printf %s ([A-Za-z0-9+/=]+) \| base64 -d\)"/.exec(cmd)
    expect(probe).not.toBeNull()
    expect(Buffer.from(probe![1], 'base64').toString('utf8')).toBe('x'.repeat(40))
  })

  it('never embeds the raw prompt, and stays single-quote-clean for the host shell', () => {
    const nasty = "it's $HOME; \"quoted\""
    const cmd = buildPromptPasteCmd('yaac:claude', nasty, PATHS)
    expect(cmd).not.toContain('$HOME')
    // The one single-quote pair is the outer sh -c wrapper; the script body
    // must not contain any (the host shell would split the command there).
    expect(cmd.startsWith("sh -c '")).toBe(true)
    expect(cmd.endsWith("'")).toBe(true)
    expect(cmd.slice("sh -c '".length, -1)).not.toContain("'")
  })

  it.each(AGENT_TOOLS)('targets the %s agent window', (tool) => {
    const cmd = buildPromptPasteCmd(`yaac:${tool}`, 'prompt', PATHS)
    expect(cmd).toContain(`paste-buffer -p -d -b yaac-prompt -t yaac:${tool}`)
    expect(cmd).toContain(`send-keys -t yaac:${tool} Enter`)
  })

  it('gates on the alternate screen, verify-pastes, then submits with a guard resend', () => {
    const cmd = buildPromptPasteCmd('yaac:codex', 'hello', PATHS)
    // Order matters: alternate_on readiness gate → paste-until-visible loop
    // (capture-pane grep) → Enter → delayed second Enter for a TUI that
    // dropped the first one mid-startup-render.
    expect(cmd).toMatch(
      /while .*alternate_on.* sleep 0\.5; done; sleep 1; probe=.*; i=0; while .*capture-pane .* grep -qF -- "\$probe" && break; printf %s \S+ \| base64 -d \| .*load-buffer .*; .*paste-buffer -p .*; i=.*; sleep 2; done; .*send-keys .* Enter; sleep 2; .*send-keys .* Enter'$/,
    )
  })

  it('degrades to a single blind paste for a whitespace-only prompt', () => {
    const cmd = buildPromptPasteCmd('yaac:claude', ' \n ', PATHS)
    expect(cmd).not.toContain('probe=')
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
    // The delay is the whole trick: respawn-window reports success even for
    // a command that dies instantly, so the probe has to let it die first.
    const cmd = buildAgentWindowCheck(['claude'], PATHS)
    expect(cmd).toContain('sleep 1;')
    expect(cmd).toContain(`names=\\$(${TMUX} list-windows -t =yaac -F '#{window_name}')`)
    expect(cmd).toContain('grep -qxF claude')
  })

  it('checks every window a multi-agent launch asked for, in one probe', () => {
    // A restart resuming several conversations opens `claude`, `claude-2`,
    // `codex` — one exit code covers the set, and each missing name is
    // echoed so the caller's message can say which died.
    const cmd = buildAgentWindowCheck(['claude', 'claude-2', 'codex'], PATHS)
    for (const w of ['claude', 'claude-2', 'codex']) {
      expect(cmd).toContain(`grep -qxF ${w} || { echo ${w} >&2; rc=1; }`)
    }
    // One list-windows for all of them, and one sleep.
    expect(cmd.match(/list-windows/g)).toHaveLength(1)
    expect(cmd.match(/sleep 1/g)).toHaveLength(1)
    expect(cmd.endsWith('exit \\$rc"')).toBe(true)
  })

  it('fails the probe when tmux itself is gone, rather than reading no windows as no agents', () => {
    // `names=$(...) || exit 1` — a dead tmux server must not present as
    // "every window is missing", which reads as an agent problem.
    expect(buildAgentWindowCheck(['claude'], PATHS)).toContain("#{window_name}') || exit 1")
  })
})

describe('verifyAgentWindowAlive', () => {
  // No `mockClear()` between these: clearing a spy that has already returned
  // a promise makes vitest report a LATER rejected result as an unhandled
  // error, failing the test even though the assertion passes. Each case sets
  // its own implementation instead, which is all these need.
  it('relay-execs the window probe and passes when it exits 0', async () => {
    podExec.mockImplementation(() => Promise.resolve({ stdout: '', stderr: '' }))
    await expect(verifyAgentWindowAlive('yaac-job-1', ['codex'])).resolves.toBeUndefined()
    // Read the arguments rather than matching the whole call: a driver
    // delegation passes its optional opts through, so the recorded call
    // carries a trailing undefined the caller never wrote.
    expect(podExec.mock.calls.at(-1)?.slice(0, 2))
      .toEqual(['yaac-job-1', buildAgentWindowCheck(['codex'], PATHS)])
  })

  it('reports a missing window as a dead agent when the probe ran in the pod', async () => {
    podExec.mockImplementation(
      () => Promise.reject(new WorkspaceExecError('command exited 1', 1, '', 'no server running on /tmp/yaac.sock')),
    )
    // A dead tmux server exits nonzero too — its stderr is what tells the
    // two apart, so it has to reach the message.
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
    // The probe never reached the pod, so it says nothing about the window —
    // calling that a dead agent would send the user hunting the wrong bug.
    podExec.mockImplementation(
      () => Promise.reject(new Error('stream relay dial: timeout')),
    )
    await expect(verifyAgentWindowAlive('yaac-job-1', ['codex']))
      .rejects.toThrow('stream relay dial: timeout')
  })

  it('types the verdict, so a caller that cannot rethrow still tells the two apart', async () => {
    // The create fires this probe without awaiting it, so its handler sees
    // every rejection and has no try/catch to honor the split with. Filing a
    // transport blip as a dead agent there hides a live worktree behind an
    // error row, so the distinction has to survive as a type.
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
