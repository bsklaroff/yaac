import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  verifyAgentWindowAlive,
  AgentLaunchDeadError,
  initWindowCommand,
  resolveInitWindows,
} from '#runtime/agents/agent-command'
import { installFakeWorkspaceDriver, workspacePathsFixture } from '#test/support/fake-driver'
import { WorkspaceExecError, type WorkspaceDriver } from '#drivers/contract'

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

describe('initWindowCommand', () => {
  it('creates a visible window with remain-on-exit chained on', () => {
    const cmd = initWindowCommand({ name: 'init', cmd: 'pnpm install', hidePane: false }, PATHS)
    expect(cmd).toBe(
      `${TMUX} new-window -d -t yaac -n init "\${SHELL:-/bin/sh}" -c 'cd /workspace && pnpm install'`
      + ' \\; set-option -t =yaac:=init remain-on-exit on',
    )
  })

  it('omits remain-on-exit for hidden panes', () => {
    const cmd = initWindowCommand({ name: 'deps', cmd: 'pnpm install', hidePane: true }, PATHS)
    expect(cmd).toBe(`${TMUX} new-window -d -t yaac -n deps "\${SHELL:-/bin/sh}" -c 'cd /workspace && pnpm install'`)
  })
})

describe('resolveInitWindows', () => {
  it('has no init window when the config names no commands', () => {
    expect(resolveInitWindows({})).toEqual([])
    expect(resolveInitWindows({ initCommands: [] })).toEqual([])
  })

  it('collapses a string list into one `init` window, shell-escaped, under hideInitPane', () => {
    expect(resolveInitWindows({ initCommands: ['pnpm install', "echo 'hi'"], hideInitPane: true })).toEqual([
      { name: 'init', cmd: "pnpm install && echo '\\''hi'\\''", hidePane: true },
    ])
  })

  it('opens a window per object entry, each overriding hideInitPane on its own', () => {
    expect(resolveInitWindows({
      initCommands: [
        { name: 'backend', commands: ['pnpm dev:backend'] },
        { name: 'frontend', commands: ['pnpm install', 'pnpm dev:frontend'], hidePane: true },
      ],
      hideInitPane: false,
    })).toEqual([
      { name: 'backend', cmd: 'pnpm dev:backend', hidePane: false },
      { name: 'frontend', cmd: 'pnpm install && pnpm dev:frontend', hidePane: true },
    ])
  })
})
