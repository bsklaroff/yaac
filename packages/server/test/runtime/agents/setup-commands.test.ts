import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  buildUpstreamExec,
  buildWindowsExec,
  buildWorktreeLinkExec,
  validateInitWindows,
} from '#runtime/agents/setup-commands'
import { WORKTREE_INIT_SCRIPT, worktreeBinDir } from '#domain/worktrees/worktree-bin'
import { PROXY_CA_BUNDLE_PATH } from '#drivers/k8s/egress/proxy-client'
import { AGENT_TOOLS } from '@yaac/shared/types'

import { workspacePathsFixture } from '@yaac/test-utils/fake-driver'

// The container paths these commands are written against.
const PATHS = workspacePathsFixture()
const TMUX = `tmux -S ${PATHS.tmuxSock}`

describe('buildWorktreeLinkExec', () => {
  it('rewrites the gitdir pair and drops the prune lock in one command', () => {
    const cmd = buildWorktreeLinkExec('sid-1', PATHS)
    expect(cmd).toBe(
      "echo 'gitdir: /repo/.git/worktrees/sid-1' > /workspace/.git"
      + " && echo '/workspace/.git' > /repo/.git/worktrees/sid-1/gitdir"
      + " && printf 'yaac worktree sid-1' > /repo/.git/worktrees/sid-1/locked",
    )
  })
})

describe('buildUpstreamExec', () => {
  it('sets the upstream from inside /workspace, shell-escaped', () => {
    expect(buildUpstreamExec('origin/release/2.x', PATHS)).toBe(
      "git -C /workspace branch --set-upstream-to 'origin/release/2.x'",
    )
  })
})

describe('validateInitWindows', () => {
  it('resolves the configured windows', () => {
    const wins = validateInitWindows({ initCommands: ['pnpm install'] })
    expect(wins).toHaveLength(1)
    expect(wins[0].name).toBe('init')
  })

  it('returns [] for a config without init commands', () => {
    expect(validateInitWindows({})).toEqual([])
  })

  it.each(AGENT_TOOLS)('rejects a window named after the %s tool', (tool) => {
    expect(() => validateInitWindows({
      initCommands: [{ name: tool, commands: ['true'] }],
    })).toThrow(/collides with an agent tool window/)
  })
})

describe('buildWindowsExec', () => {
  it('with no init windows, only respawns the agent into the keepalive window', () => {
    const cmd = buildWindowsExec([], 'claude', [{ tool: 'claude', cmd: 'claude --session-id x' }], PATHS)
    expect(cmd).toBe(`${TMUX} respawn-window -k -t yaac:claude 'claude --session-id x'`)
  })

  it('chains each init window before the agent respawn', () => {
    const wins = validateInitWindows({ initCommands: ['pnpm install', 'pnpm dev'] })
    const cmd = buildWindowsExec(wins, 'codex', [{ tool: 'codex', cmd: 'codex --yolo' }], PATHS)
    const [initPart, respawnPart] = cmd.split(' && tmux -S ')
    expect(initPart).toContain('new-window -d -t yaac -n init')
    expect(initPart).toContain('pnpm install && pnpm dev')
    expect(`tmux -S ${respawnPart}`).toBe(
      `${TMUX} respawn-window -k -t yaac:codex 'codex --yolo'`,
    )
  })
})

// The pod-side half of session setup lives in the yaac-worktree-init script
// (the postStart hook). Pin the contracts the server relies on so a script
// edit can't silently drift from the TypeScript side.
describe('yaac-worktree-init script', () => {
  const scriptPath = path.join(worktreeBinDir(), WORKTREE_INIT_SCRIPT)

  it('ships in worktree-bin and is executable', async () => {
    const st = await fs.stat(scriptPath)
    expect(st.isFile()).toBe(true)
    expect(st.mode & 0o111).not.toBe(0)
  })

  it('drives tmux over the same pod-local socket the k8s driver answers with', async () => {
    // The script is baked into the image, so it cannot ask the driver — it
    // hard-codes the path, and this is what catches the two drifting apart.
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
    // The engine-start block hardcodes the bundle path (sudo strips env, so
    // the script can't read it from the pod) — pin it to the constant so a
    // moved bundle can't silently break nested registry TLS.
    const body = await fs.readFile(scriptPath, 'utf8')
    expect(body).toContain(`SSL_CERT_FILE=${PROXY_CA_BUNDLE_PATH}`)
  })

  it('never does git work from /workspace (the checkout races the hook)', async () => {
    const body = await fs.readFile(scriptPath, 'utf8')
    // The hook cd's to / before any git command: /workspace holds a
    // half-provisioned worktree whose .git file still names the HOST admin
    // path, and git's cwd repository discovery treats that as fatal even
    // for `config --global`.
    expect(body.indexOf('\ncd /\n')).toBeGreaterThan(-1)
    expect(body.indexOf('\ncd /\n')).toBeLessThan(body.indexOf('git config --global'))
    // The tmux session pins its start directory back to the worktree so
    // the respawned agent and later windows run there.
    expect(body).toMatch(/new-session[^\n]* -c \/workspace/)
  })

  it('starts streamd last, from the path the self-heal exec also uses', async () => {
    const body = await fs.readFile(scriptPath, 'utf8')
    const streamdAt = body.indexOf('node /opt/yaac/streamd/main.js')
    expect(streamdAt).toBeGreaterThan(-1)
    // Everything the server relies on (git config, tmux) precedes streamd:
    // its reachability is the "setup done" signal.
    expect(body.indexOf('git config --global')).toBeLessThan(streamdAt)
    expect(body.indexOf('new-session')).toBeLessThan(streamdAt)
    expect(body.indexOf('podman system service')).toBeLessThan(streamdAt)
  })
})
