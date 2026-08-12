import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildAgentCmd,
  agentWindowTarget,
  buildPromptPasteCmd,
  buildPromptPasteBgCmd,
  typeInitialPrompt,
  buildAgentWindowCheck,
  verifyAgentWindowAlive,
  initWindowCommand,
} from '#runtime/agents/agent-command'
import { RelayExecError, podExec } from '#runtime/k8s/substrate/stream-relay'
import type * as streamRelayModule from '#runtime/k8s/substrate/stream-relay'
import { PI_DEFAULT_PROVIDER, piProviderInfo } from '@yaac/shared/tool-providers'
import { AGENT_TOOLS } from '@yaac/shared/types'
import { CONTAINER_TMUX_SOCK } from '@yaac/shared/paths'

vi.mock('#runtime/k8s/substrate/exec', () => ({
  containerExec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execTarget: (jobName: string) => `job/${jobName}`,
}))

// Keep the real error classes — verifyAgentWindowAlive branches on
// RelayExecError to tell "the probe ran and the window is gone" apart from
// "the pod was never reached".
vi.mock('#runtime/k8s/substrate/stream-relay', async (importOriginal) => ({
  ...await importOriginal<typeof streamRelayModule>(),
  podExec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

const TMUX = `tmux -S ${CONTAINER_TMUX_SOCK}`

describe('buildAgentCmd', () => {
  describe('codex tool', () => {
    it('omits prompt arguments', () => {
      const cmd = buildAgentCmd('codex', 'sess-1')
      expect(cmd).toBe('codex --yolo')
    })

    it('inserts the resume subcommand when resuming', () => {
      const cmd = buildAgentCmd('codex', 'sess-1', true)
      expect(cmd).toBe('codex --yolo resume sess-1')
    })

    it('inserts --model when a model override is given', () => {
      const cmd = buildAgentCmd('codex', 'sess-1', false, undefined, 'gpt-5.2-codex')
      expect(cmd).toBe('codex --yolo --model gpt-5.2-codex')
    })

    it('places --model after the resume subcommand (codex resume parses it)', () => {
      const cmd = buildAgentCmd('codex', 'abc', true, undefined, 'gpt-5.2-codex')
      expect(cmd).toBe('codex --yolo resume abc --model gpt-5.2-codex')
    })
  })

  describe('opencode tool', () => {
    it('starts the loopback server and omits model flags by default', () => {
      const cmd = buildAgentCmd('opencode', 'sess-1')
      expect(cmd).toBe('opencode --port 4096 --hostname 127.0.0.1')
    })

    it('appends --continue when resuming', () => {
      const cmd = buildAgentCmd('opencode', 'sess-1', true)
      expect(cmd).toBe('opencode --port 4096 --hostname 127.0.0.1 --continue')
    })

    it('inserts a provider/model override', () => {
      const cmd = buildAgentCmd('opencode', 'sess-1', false, undefined, 'anthropic/claude-opus-4-8')
      expect(cmd).toBe('opencode --port 4096 --hostname 127.0.0.1 --model anthropic/claude-opus-4-8')
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
      const cmd = buildAgentCmd('pi', 'sess-1')
      expect(cmd).toBe(wrapped(`pi --approve --model ${defaultModel} --session-id sess-1`))
    })

    it('uses the given provider default model', () => {
      const cmd = buildAgentCmd('pi', 'sess-1', false, 'anthropic')
      expect(cmd).toBe(wrapped(`pi --approve --model ${anthropicModel} --session-id sess-1`))
    })

    it('addresses the session by id when resuming (same command as create)', () => {
      const cmd = buildAgentCmd('pi', 'sess-1', true, 'anthropic')
      expect(cmd).toBe(wrapped(`pi --approve --model ${anthropicModel} --session-id sess-1`))
    })

    it('prefers an explicit model override over the provider default', () => {
      const cmd = buildAgentCmd('pi', 'sess-1', false, 'anthropic', 'openai/gpt-5.2')
      expect(cmd).toBe(wrapped('pi --approve --model openai/gpt-5.2 --session-id sess-1'))
    })

    it('filters the fresh-run warning without single quotes (survives respawn wrapper)', () => {
      const cmd = buildAgentCmd('pi', 'sess-1')
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
    it('omits prompt flags', () => {
      const cmd = buildAgentCmd('claude', 'sess-1')
      expect(cmd).toBe('CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --session-id sess-1')
    })

    it('swaps --session-id for --resume when resuming', () => {
      const cmd = buildAgentCmd('claude', 'sess-1', true)
      expect(cmd).toBe('CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --resume sess-1')
    })

    it('inserts --model when a model override is given', () => {
      const cmd = buildAgentCmd('claude', 'sess-1', false, undefined, 'claude-opus-4-8')
      expect(cmd).toBe('CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --model claude-opus-4-8 --session-id sess-1')
    })

    it('combines a model override with resume', () => {
      const cmd = buildAgentCmd('claude', 'sess-1', true, undefined, 'opus')
      expect(cmd).toBe('CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --model opus --resume sess-1')
    })
  })
})

/** Pull the paste's base64 payload back out of the generated command. */
function embeddedPrompt(cmd: string): string {
  const match = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| tmux[^|]*load-buffer/.exec(cmd)
  expect(match).not.toBeNull()
  return Buffer.from(match![1], 'base64').toString('utf8')
}

describe('agentWindowTarget', () => {
  it.each(AGENT_TOOLS)('addresses the %s primary agent window', (tool) => {
    // Session create's initial ask goes to the window; a later message goes to
    // a pane id instead, since a worktree with several conversations has only
    // one `yaac:<tool>` window between them.
    expect(agentWindowTarget(tool)).toBe(`yaac:${tool}`)
  })
})

describe('buildPromptPasteCmd', () => {
  it('round-trips arbitrary prompt text through the base64 payload', () => {
    const nasty = 'say "hi" && don\'t eval `$HOME`\nsecond line — ünïcode'
    expect(embeddedPrompt(buildPromptPasteCmd('yaac:claude', nasty))).toBe(nasty)
  })

  it('verifies the paste against the first line, capped at 40 columns', () => {
    const prompt = `${'x'.repeat(60)} tail\nsecond line`
    const cmd = buildPromptPasteCmd('yaac:claude', prompt)
    const probe = /probe="\$\(printf %s ([A-Za-z0-9+/=]+) \| base64 -d\)"/.exec(cmd)
    expect(probe).not.toBeNull()
    expect(Buffer.from(probe![1], 'base64').toString('utf8')).toBe('x'.repeat(40))
  })

  it('never embeds the raw prompt, and stays single-quote-clean for the host shell', () => {
    const nasty = "it's $HOME; \"quoted\""
    const cmd = buildPromptPasteCmd('yaac:claude', nasty)
    expect(cmd).not.toContain('$HOME')
    // The one single-quote pair is the outer sh -c wrapper; the script body
    // must not contain any (the host shell would split the command there).
    expect(cmd.startsWith("sh -c '")).toBe(true)
    expect(cmd.endsWith("'")).toBe(true)
    expect(cmd.slice("sh -c '".length, -1)).not.toContain("'")
  })

  it.each(AGENT_TOOLS)('targets the %s agent window', (tool) => {
    const cmd = buildPromptPasteCmd(agentWindowTarget(tool), 'prompt')
    expect(cmd).toContain(`paste-buffer -p -d -b yaac-prompt -t yaac:${tool}`)
    expect(cmd).toContain(`send-keys -t yaac:${tool} Enter`)
  })

  it('gates on the alternate screen, verify-pastes, then submits with a guard resend', () => {
    const cmd = buildPromptPasteCmd('yaac:codex', 'hello')
    // Order matters: alternate_on readiness gate → paste-until-visible loop
    // (capture-pane grep) → Enter → delayed second Enter for a TUI that
    // dropped the first one mid-startup-render.
    expect(cmd).toMatch(
      /while .*alternate_on.* sleep 0\.5; done; sleep 1; probe=.*; i=0; while .*capture-pane .* grep -qF -- "\$probe" && break; printf %s \S+ \| base64 -d \| .*load-buffer .*; .*paste-buffer -p .*; i=.*; sleep 2; done; .*send-keys .* Enter; sleep 2; .*send-keys .* Enter'$/,
    )
  })

  it('degrades to a single blind paste for a whitespace-only prompt', () => {
    const cmd = buildPromptPasteCmd('yaac:claude', ' \n ')
    expect(cmd).not.toContain('probe=')
    expect(cmd).toContain('paste-buffer -p -d -b yaac-prompt -t yaac:claude')
  })
})

describe('buildPromptPasteBgCmd', () => {
  it('decodes the paste script to a pod file and detaches it with setsid', () => {
    const cmd = buildPromptPasteBgCmd('yaac:claude', 'hello')
    expect(cmd).toMatch(/^printf %s [A-Za-z0-9+/=]+ \| base64 -d > \/tmp\/\.yaac-prompt\.sh/)
    expect(cmd).toContain('setsid sh /tmp/.yaac-prompt.sh >/tmp/yaac-prompt.log 2>&1 </dev/null &')
  })

  it('embeds exactly the script buildPromptPasteCmd wraps', () => {
    const cmd = buildPromptPasteBgCmd('yaac:codex', "it's $HOME\nline 2")
    const b64 = /^printf %s ([A-Za-z0-9+/=]+) \|/.exec(cmd)
    expect(b64).not.toBeNull()
    const script = Buffer.from(b64![1], 'base64').toString('utf8')
    expect(`sh -c '${script}'`).toBe(buildPromptPasteCmd('yaac:codex', "it's $HOME\nline 2"))
  })
})

describe('typeInitialPrompt', () => {
  beforeEach(() => vi.mocked(podExec).mockClear())

  it('relay-execs the detached paste command single-attempt (a retry could double-paste)', async () => {
    await typeInitialPrompt('yaac-job-1', 'claude', 'hello there')
    expect(podExec).toHaveBeenCalledWith(
      'yaac-job-1',
      buildPromptPasteBgCmd('yaac:claude', 'hello there'),
      { maxAttempts: 1, timeout: 15_000 },
    )
  })
})

describe('buildAgentWindowCheck', () => {
  it('probes for the agent window after a settle delay', () => {
    expect(buildAgentWindowCheck('claude')).toBe(
      `sh -c "sleep 1; ${TMUX} list-windows -t =yaac -F '#{window_name}' | grep -qxF claude"`,
    )
  })
})

describe('verifyAgentWindowAlive', () => {
  // No `mockClear()` between these: clearing a spy that has already returned
  // a promise makes vitest report a LATER rejected result as an unhandled
  // error, failing the test even though the assertion passes. Each case sets
  // its own implementation instead, which is all these need.
  it('relay-execs the window probe and passes when it exits 0', async () => {
    vi.mocked(podExec).mockImplementation(() => Promise.resolve({ stdout: '', stderr: '' }))
    await expect(verifyAgentWindowAlive('yaac-job-1', 'codex')).resolves.toBeUndefined()
    expect(podExec).toHaveBeenCalledWith('yaac-job-1', buildAgentWindowCheck('codex'))
  })

  it('reports a missing window as a dead agent when the probe ran in the pod', async () => {
    vi.mocked(podExec).mockImplementation(
      () => Promise.reject(new RelayExecError('command exited 1', 1, '', 'no server running on /tmp/yaac.sock')),
    )
    // The probe is `list-windows | grep`, so a dead tmux server exits
    // nonzero too — its stderr is what tells the two apart.
    await expect(verifyAgentWindowAlive('yaac-job-1', 'codex'))
      .rejects.toThrow(/agent "codex" exited right after its respawn.*no server running/s)
  })

  it('propagates a transport failure instead of blaming the agent', async () => {
    // The probe never reached the pod, so it says nothing about the window —
    // calling that a missing tool would send the user hunting the wrong bug.
    vi.mocked(podExec).mockImplementation(
      () => Promise.reject(new Error('stream relay dial: timeout')),
    )
    await expect(verifyAgentWindowAlive('yaac-job-1', 'codex'))
      .rejects.toThrow('stream relay dial: timeout')
  })
})

describe('initWindowCommand', () => {
  it('creates a visible window with remain-on-exit chained on', () => {
    const cmd = initWindowCommand({ name: 'init', cmd: 'pnpm install', hidePane: false })
    expect(cmd).toBe(
      `${TMUX} new-window -d -t yaac -n init 'cd /workspace && pnpm install'`
      + ' \\; set-option -t yaac:init remain-on-exit on',
    )
  })

  it('omits remain-on-exit for hidden panes', () => {
    const cmd = initWindowCommand({ name: 'deps', cmd: 'pnpm install', hidePane: true })
    expect(cmd).toBe(`${TMUX} new-window -d -t yaac -n deps 'cd /workspace && pnpm install'`)
  })
})
