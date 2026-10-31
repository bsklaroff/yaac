import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { buildWindowsExec, finishSetupCommand } from '#runtime/agents/setup-commands'
import { KEEPER_STARTING, KEEPER_WINDOW } from '#drivers/contract'
import { resolveInitWindows } from '#runtime/agents/agent-command'
import { WORKSPACE_INIT_SCRIPT, workspaceBinDir } from '#domain/workspaces/workspace-bin'
import { PROXY_CA_BUNDLE_PATH } from '#drivers/k8s/egress/proxy-client'

import { workspacePathsFixture } from '#test/support/fake-driver'

// The container paths these commands are written against.
const PATHS = workspacePathsFixture()
const TMUX = `tmux -S ${PATHS.tmuxSock}`

describe('buildWindowsExec', () => {
  const claude = { tool: 'claude' as const, window: 'claude-aaaa', cmd: 'claude --session-id x' }

  // A session's window keeps its pane when the agent exits, for a resume.
  it('opens each session in a window of its own, in the workspace, keeping its pane on exit', () => {
    expect(buildWindowsExec([], [claude], PATHS)).toBe(
      `${TMUX} new-window -d -t yaac -n claude-aaaa -c ${PATHS.workspaceDir} 'claude --session-id x'`
      + ' \\; set-option -t =yaac:=claude-aaaa remain-on-exit on',
    )
  })

  it('chains each init window before the sessions', () => {
    const wins = resolveInitWindows({ initCommands: ['pnpm install', 'pnpm dev'] })
    const cmd = buildWindowsExec(wins, [claude], PATHS)
    const [initPart, sessionPart] = cmd.split(' && tmux -S ')
    expect(initPart).toContain('new-window -d -t yaac -n init')
    expect(initPart).toContain('pnpm install && pnpm dev')
    expect(sessionPart).toContain('-n claude-aaaa')
  })

  it('opens only the init windows when the sessions were started apart', () => {
    const wins = resolveInitWindows({ initCommands: ['pnpm dev'] })
    const cmd = buildWindowsExec(wins, [], PATHS)
    expect(cmd).toContain('pnpm dev')
    expect(cmd).not.toContain('claude')
    expect(buildWindowsExec([], [], PATHS)).toBe('')
  })

  it('starts every session in one tmux command, each naming what it resumes', () => {
    // One command, so no pane listing sees a window before it names what it
    // resumes (codex reports that only at its next turn).
    const cmd = buildWindowsExec([], [
      { tool: 'codex', window: 'codex-bbbb', cmd: 'codex resume t-1', resumes: 't-1' },
      { tool: 'opencode', window: 'opencode-cccc', cmd: 'opencode --standalone --session ses_2', resumes: 'ses_2' },
    ], PATHS)
    expect(cmd).toBe(
      `${TMUX} new-window -d -t yaac -n codex-bbbb -c ${PATHS.workspaceDir} 'codex resume t-1'`
      + ' \\; set-option -t =yaac:=codex-bbbb remain-on-exit on'
      + " \\; set-option -p -t =yaac:=codex-bbbb @yaac-session 'codex|t-1|'"
      + ` \\; new-window -d -t yaac -n opencode-cccc -c ${PATHS.workspaceDir} 'opencode --standalone --session ses_2'`
      + ' \\; set-option -t =yaac:=opencode-cccc remain-on-exit on'
      + " \\; set-option -p -t =yaac:=opencode-cccc @yaac-session 'opencode|ses_2|'",
    )
  })
})

describe('finishSetupCommand', () => {
  // The reaper reads a keeper still named for its start as a create that
  // died partway (`probeSetupState`), so setup ends by renaming it, and a
  // workspace with no keeper (one started before keepers) is not an error.
  it('renames the keeper, tolerating a workspace without one', () => {
    expect(finishSetupCommand(PATHS)).toBe(`${TMUX} rename-window -t =yaac:=${KEEPER_STARTING} ${KEEPER_WINDOW} 2>/dev/null || true`)
  })
})

// Pod-side setup is the yaac-workspace-init script (the postStart hook).
// Pin what the server relies on so the two cannot drift apart.
describe('yaac-workspace-init script', () => {
  const scriptPath = path.join(workspaceBinDir(), WORKSPACE_INIT_SCRIPT)

  it('ships in workspace-bin and is executable', async () => {
    const st = await fs.stat(scriptPath)
    expect(st.isFile()).toBe(true)
    expect(st.mode & 0o111).not.toBe(0)
  })

  it('drives tmux over the same pod-local socket the k8s driver answers with', async () => {
    // The script hard-codes the socket path.
    const body = await fs.readFile(scriptPath, 'utf8')
    expect(body).toContain(`tmux -S ${PATHS.tmuxSock}`)
  })

  it('opens the session on the keeper, named for its start', async () => {
    const body = await fs.readFile(scriptPath, 'utf8')
    expect(body).toMatch(new RegExp(`new-session -d -s yaac -n ${KEEPER_STARTING} `))
  })

  it('consumes exactly the env session-create injects', async () => {
    const body = await fs.readFile(scriptPath, 'utf8')
    for (const name of [
      'YAAC_GIT_NAME', 'YAAC_GIT_EMAIL', 'YAAC_STATUS_RIGHT',
      'YAAC_NESTED_ENGINE', 'YAAC_REGISTRY_CONF_B64',
    ]) {
      // Both plain `$NAME` and defaulted `${NAME:-}` expansions count.
      expect(body).toMatch(new RegExp(`\\$\\{?${name}`))
    }
  })

  it('points the nested engine at the combined CA bundle (PROXY_CA_BUNDLE_PATH)', async () => {
    // Hard-coded in the script because sudo strips the environment.
    const body = await fs.readFile(scriptPath, 'utf8')
    expect(body).toContain(`SSL_CERT_FILE=${PROXY_CA_BUNDLE_PATH}`)
  })

  it('never does git work from /workspace (the checkout races the hook)', async () => {
    const body = await fs.readFile(scriptPath, 'utf8')
    // `cd /` before any git command: git fails on the half-set-up
    // /workspace repo, even for `config --global`.
    expect(body.indexOf('\ncd /\n')).toBeGreaterThan(-1)
    expect(body.indexOf('\ncd /\n')).toBeLessThan(body.indexOf('git config --global'))
    // Windows still start in /workspace.
    expect(body).toMatch(/new-session[^\n]* -c \/workspace/)
  })

  it('starts streamd last, from the path the self-heal exec also uses', async () => {
    const body = await fs.readFile(scriptPath, 'utf8')
    const streamdAt = body.indexOf('node /opt/yaac/streamd/main.js')
    expect(streamdAt).toBeGreaterThan(-1)
    // streamd starts last: its reachability signals that setup is done.
    expect(body.indexOf('git config --global')).toBeLessThan(streamdAt)
    expect(body.indexOf('new-session')).toBeLessThan(streamdAt)
    expect(body.indexOf('podman system service')).toBeLessThan(streamdAt)
  })
})
