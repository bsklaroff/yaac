import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildPromptPasteCmd, typeInitialPrompt } from '#features/sessions/create'
import { containerExec } from '#platform/k8s/exec'
import { AGENT_TOOLS } from '@yaac/shared/types'

vi.mock('#platform/k8s/exec', () => ({
  containerExec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execTarget: (jobName: string) => `job/${jobName}`,
}))

/** Pull the paste's base64 payload back out of the generated command. */
function embeddedPrompt(cmd: string): string {
  const match = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| tmux[^|]*load-buffer/.exec(cmd)
  expect(match).not.toBeNull()
  return Buffer.from(match![1], 'base64').toString('utf8')
}

describe('buildPromptPasteCmd', () => {
  it('round-trips arbitrary prompt text through the base64 payload', () => {
    const nasty = 'say "hi" && don\'t eval `$HOME`\nsecond line — ünïcode'
    expect(embeddedPrompt(buildPromptPasteCmd('claude', nasty))).toBe(nasty)
  })

  it('verifies the paste against the first line, capped at 40 columns', () => {
    const prompt = `${'x'.repeat(60)} tail\nsecond line`
    const cmd = buildPromptPasteCmd('claude', prompt)
    const probe = /probe="\$\(printf %s ([A-Za-z0-9+/=]+) \| base64 -d\)"/.exec(cmd)
    expect(probe).not.toBeNull()
    expect(Buffer.from(probe![1], 'base64').toString('utf8')).toBe('x'.repeat(40))
  })

  it('never embeds the raw prompt, and stays single-quote-clean for the host shell', () => {
    const nasty = "it's $HOME; \"quoted\""
    const cmd = buildPromptPasteCmd('claude', nasty)
    expect(cmd).not.toContain('$HOME')
    // The one single-quote pair is the outer sh -c wrapper; the script body
    // must not contain any (the host shell would split the command there).
    expect(cmd.startsWith("sh -c '")).toBe(true)
    expect(cmd.endsWith("'")).toBe(true)
    expect(cmd.slice("sh -c '".length, -1)).not.toContain("'")
  })

  it.each(AGENT_TOOLS)('targets the %s agent window', (tool) => {
    const cmd = buildPromptPasteCmd(tool, 'prompt')
    expect(cmd).toContain(`paste-buffer -p -d -b yaac-prompt -t yaac:${tool}`)
    expect(cmd).toContain(`send-keys -t yaac:${tool} Enter`)
  })

  it('gates on the alternate screen, verify-pastes, then submits with a guard resend', () => {
    const cmd = buildPromptPasteCmd('codex', 'hello')
    // Order matters: alternate_on readiness gate → paste-until-visible loop
    // (capture-pane grep) → Enter → delayed second Enter for a TUI that
    // dropped the first one mid-startup-render.
    expect(cmd).toMatch(
      /while .*alternate_on.* sleep 0\.5; done; sleep 1; probe=.*; i=0; while .*capture-pane .* grep -qF -- "\$probe" && break; printf %s \S+ \| base64 -d \| .*load-buffer .*; .*paste-buffer -p .*; i=.*; sleep 2; done; .*send-keys .* Enter; sleep 2; .*send-keys .* Enter'$/,
    )
  })

  it('degrades to a single blind paste for a whitespace-only prompt', () => {
    const cmd = buildPromptPasteCmd('claude', ' \n ')
    expect(cmd).not.toContain('probe=')
    expect(cmd).toContain('paste-buffer -p -d -b yaac-prompt -t yaac:claude')
  })
})

describe('typeInitialPrompt', () => {
  beforeEach(() => vi.mocked(containerExec).mockClear())

  it('execs the paste command in the session job, single-attempt (a retry could double-paste)', async () => {
    await typeInitialPrompt('yaac-job-1', 'claude', 'hello there')
    expect(containerExec).toHaveBeenCalledWith(
      'yaac-job-1',
      buildPromptPasteCmd('claude', 'hello there'),
      { maxAttempts: 1, timeout: 120_000 },
    )
  })
})
