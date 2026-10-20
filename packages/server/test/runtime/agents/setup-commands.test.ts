import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { buildWindowsExec } from '#runtime/agents/setup-commands'
import { resolveInitWindows } from '#runtime/agents/agent-command'
import { WORKSPACE_INIT_SCRIPT, workspaceBinDir } from '#domain/workspaces/workspace-bin'
import { PROXY_CA_BUNDLE_PATH } from '#drivers/k8s/egress/proxy-client'

import { workspacePathsFixture } from '#test/support/fake-driver'

// The container paths these commands are written against.
const PATHS = workspacePathsFixture()
const TMUX = `tmux -S ${PATHS.tmuxSock}`

describe('buildWindowsExec', () => {
  it('with no init windows, only respawns the agent into the keepalive window', () => {
    const cmd = buildWindowsExec([], 'claude', [{ tool: 'claude', cmd: 'claude --session-id x' }], PATHS)
    expect(cmd).toBe(`${TMUX} respawn-window -k -t yaac:claude 'claude --session-id x'`)
  })

  it('chains each init window before the agent respawn', () => {
    const wins = resolveInitWindows({ initCommands: ['pnpm install', 'pnpm dev'] })
    const cmd = buildWindowsExec(wins, 'codex', [{ tool: 'codex', cmd: 'codex --yolo' }], PATHS)
    const [initPart, respawnPart] = cmd.split(' && tmux -S ')
    expect(initPart).toContain('new-window -d -t yaac -n init')
    expect(initPart).toContain('pnpm install && pnpm dev')
    expect(`tmux -S ${respawnPart}`).toBe(
      `${TMUX} respawn-window -k -t yaac:codex 'codex --yolo'`,
    )
  })

  it('opens only the init windows when the agents were started apart', () => {
    const wins = resolveInitWindows({ initCommands: ['pnpm dev'] })
    const cmd = buildWindowsExec(wins, 'claude', [], PATHS)
    expect(cmd).toContain('pnpm dev')
    expect(cmd).not.toContain('respawn-window')
    expect(buildWindowsExec([], 'claude', [], PATHS)).toBe('')
  })

  it('opens every agent past the first in its own window, in the workspace', () => {
    const cmd = buildWindowsExec([], 'claude', [
      { tool: 'claude', cmd: 'claude --resume a' },
      { tool: 'codex', cmd: 'codex --yolo' },
    ], PATHS)
    expect(cmd).toBe(
      `${TMUX} respawn-window -k -t yaac:claude 'claude --resume a'`
      + ` \\; new-window -d -t yaac -n codex-2 -c ${PATHS.workspaceDir} 'codex --yolo'`,
    )
  })

  it('starts every agent in one tmux command, each naming what it resumes', () => {
    // One command, so no pane listing sees a window before it names what it
    // resumes (codex reports that only at its next turn).
    const cmd = buildWindowsExec([], 'codex', [
      { tool: 'codex', cmd: 'codex resume t-1', resumes: 't-1' },
      { tool: 'opencode', cmd: 'opencode --standalone --session ses_2', resumes: 'ses_2' },
    ], PATHS)
    expect(cmd).toBe(
      `${TMUX} respawn-window -k -t yaac:codex 'codex resume t-1'`
      + " \\; set-option -p -t yaac:codex @yaac-session 'codex|t-1|'"
      + ` \\; new-window -d -t yaac -n opencode-2 -c ${PATHS.workspaceDir} 'opencode --standalone --session ses_2'`
      + " \\; set-option -p -t yaac:opencode-2 @yaac-session 'opencode|ses_2|'",
    )
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

  it('consumes exactly the env session-create injects', async () => {
    const body = await fs.readFile(scriptPath, 'utf8')
    for (const name of [
      'YAAC_TOOL', 'YAAC_GIT_NAME', 'YAAC_GIT_EMAIL', 'YAAC_STATUS_RIGHT',
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
