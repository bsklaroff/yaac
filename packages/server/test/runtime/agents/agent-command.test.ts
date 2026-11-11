import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  buildOpeningWrite,
  verifyAgentWindowAlive,
  AgentLaunchDeadError,
} from '#runtime/agents/agent-command'
import { agentDriver } from '#runtime/agents/drivers'
import { installFakeWorkspaceDriver, workspacePathsFixture } from '#test/support/fake-driver'
import { WorkspaceExecError, type WorkspaceDriver } from '#drivers/contract'
import { MAX_PROMPT_BYTES, promptFits, type AgentTool } from '@yaac/shared/types'

// In-pod paths; a containerless workspace gets its own.
const PATHS = workspacePathsFixture()
const TMUX = `tmux -S ${PATHS.tmuxSock}`

// Mock the driver's exec. The real WorkspaceExecError class is used because
// `verifyAgentWindowAlive` branches on it.
const podExec = vi.fn<WorkspaceDriver['exec']>()
  .mockResolvedValue({ stdout: '', stderr: '' })
beforeEach(() => { installFakeWorkspaceDriver({ exec: podExec }) })

describe('verifyAgentWindowAlive', () => {
  // No `mockClear()` here: clearing a spy that returned a promise makes
  // vitest report a later rejection as unhandled. Each case sets its own
  // implementation instead.
  it('probes every window in one exec after a settle delay, and passes when it exits 0', async () => {
    podExec.mockImplementation(() => Promise.resolve({ stdout: '', stderr: '' }))
    await expect(verifyAgentWindowAlive('yaac-job-1', ['claude', 'claude-2', 'codex'])).resolves.toBeUndefined()
    const [jobName, cmd] = podExec.mock.calls.at(-1)!
    expect(jobName).toBe('yaac-job-1')
    // Opening a window succeeds even if its command dies at once, so it
    // waits first. A session's window outlives its agent, so a live one is
    // listed with its pane not dead. One exit code covers all windows; each
    // missing or dead name is echoed.
    expect(cmd.match(/sleep 1;/g)).toHaveLength(1)
    expect(cmd.match(/list-windows/g)).toHaveLength(1)
    expect(cmd).toContain(`names=\\$(${TMUX} list-windows -t =yaac -F '#{window_name} #{pane_dead}')`)
    for (const w of ['claude', 'claude-2', 'codex']) {
      expect(cmd).toContain(`grep -qxF '${w} 0' || { echo ${w} >&2; rc=1; }`)
    }
    expect(cmd.endsWith('exit \\$rc"')).toBe(true)
    // A dead tmux server must fail the probe, not read as no windows.
    expect(cmd).toContain("#{pane_dead}') || exit 1")
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

/**
 * The message is left in the scratch dir and a fresh agent's launch line,
 * run under /bin/sh as a containerless launch is, reads it, with the tool
 * replaced by a stub that records its argv.
 */
describe('buildOpeningWrite', () => {
  function launchWith(tool: AgentTool, prompt: string): { argv: string[]; fileLeft: boolean } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yaac-opening-'))
    try {
      const out = path.join(dir, 'argv')
      writeFileSync(path.join(dir, tool), `#!/bin/sh\nfor a; do printf '%s\\0' "$a"; done > ${out}\n`, { mode: 0o755 })
      const paths = workspacePathsFixture({ scratchDir: dir })
      const { cmd, stdin } = buildOpeningWrite(paths, tool, prompt)
      execFileSync('/bin/sh', ['-c', cmd], { input: stdin })
      const launch = agentDriver('tui').launchCmd({
        tool, conversationId: 'sess-1', resume: false, windowName: tool, paths, cwd: paths.workspaceDir, permissionMode: 'bypass', opening: true,
      })
      // No single quotes: the command is embedded in `new-window '<cmd>'`.
      expect(launch).not.toContain("'")
      spawnSync('/bin/sh', ['-c', launch], {
        env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` },
        stdio: 'ignore',
      })
      const argv = readFileSync(out, 'utf8').split('\0').slice(0, -1)
      return { argv, fileLeft: existsSync(path.join(dir, `.yaac-opening-${tool}`)) }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /**
   * How each tool's launch ends for a message. claude runs a subcommand for
   * a one-word prompt naming one, so its gets a trailing space; pi and omp
   * attach a file for one starting with `@`, so theirs gets a leading one.
   * Each trims its pad.
   */
  const ENDINGS: Record<AgentTool, (text: string) => string[]> = {
    claude: (text) => ['--', `${text} `],
    codex: (text) => ['--', text],
    opencode: (text) => [`--prompt=${text}`],
    pi: (text) => ['--', ` ${text}`],
    omp: (text) => ['--', ` ${text}`],
  }

  it('hands every tool the message whole as its last argument, read once, where no tool takes it for a flag, file or subcommand', () => {
    const prompt = '-v "quoted" $HOME `id` \'single\'\nsecond line — ünïcode 🙂'
    for (const tool of Object.keys(ENDINGS) as AgentTool[]) {
      const { argv, fileLeft } = launchWith(tool, prompt)
      const expected = ENDINGS[tool](prompt)
      expect(argv.slice(-expected.length), tool).toEqual(expected)
      expect(fileLeft, tool).toBe(false)
    }
  })

  it('refuses to leave an empty message, as a pod whose streamd drops stdin would', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yaac-opening-'))
    try {
      const { cmd } = buildOpeningWrite(workspacePathsFixture({ scratchDir: dir }), 'claude-1', 'fix it')
      const run = spawnSync('/bin/sh', ['-c', cmd], { input: '', encoding: 'utf8' })
      expect(run.status).toBe(2)
      expect(run.stderr).toBe('the opening message did not arrive on stdin\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fits a message of the largest size a write takes in one argument for every tool', () => {
    // 20 bytes a repeat, which divides the cap.
    const prompt = 'é✓🙂 fix it no\n'.repeat(MAX_PROMPT_BYTES / 20)
    expect(promptFits(prompt) && !promptFits(`${prompt}x`)).toBe(true)
    for (const tool of Object.keys(ENDINGS) as AgentTool[]) {
      // The shell drops the trailing newline.
      const expected = ENDINGS[tool](prompt.slice(0, -1))
      expect(launchWith(tool, prompt).argv.slice(-expected.length), tool).toEqual(expected)
    }
  })
})
