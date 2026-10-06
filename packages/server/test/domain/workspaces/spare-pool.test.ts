import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { rebranchSpare, retoolSpare } from '#domain/workspaces'
import { initWindowCommand } from '#runtime/agents'
import { installFakeWorkspaceDriver, workspacePathsFixture } from '@yaac/test-utils/fake-driver'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import { projectConfigDir } from '@yaac/shared/paths'
import type { YaacConfig } from '@yaac/shared/types'

const PATHS = workspacePathsFixture()
const TMUX = `tmux -S ${PATHS.tmuxSock}`
const SPARE = { jobName: 'yaac-demo-spare1', workspaceId: 'spare1', projectId: 'demo', tool: 'claude' }

let tmpDir: string
/** Commands run in the spare, in order, with their exec options. */
let execs: Array<{ cmd: string; timeout?: number }>

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  execs = []
  installFakeWorkspaceDriver({
    exec: (_jobName, cmd, opts) => {
      execs.push({ cmd, ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}) })
      return Promise.resolve({ stdout: '', stderr: '' })
    },
  })
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

const cmds = (): string[] => execs.map((e) => e.cmd)
const respawnCmd = (): string | undefined => cmds().find((c) => c.includes('respawn-window'))

async function writeConfig(config: YaacConfig): Promise<void> {
  await fs.mkdir(projectConfigDir('demo'), { recursive: true })
  await fs.writeFile(path.join(projectConfigDir('demo'), 'yaac-config.json'), JSON.stringify(config))
}

describe('retoolSpare', () => {
  it('renames the agent window idempotently, then respawns it as the new tool', async () => {
    await retoolSpare(SPARE, { tool: 'codex', permissionMode: 'bypass', mode: 'tui' })

    // The rename may be retried, so it succeeds if already applied.
    expect(cmds()[0]).toBe(
      `${TMUX} rename-window -t yaac:claude codex`
      + ` || ${TMUX} list-windows -t =yaac -F '#{window_name}' | grep -qxF codex`,
    )
    expect(respawnCmd()).toMatch(/respawn-window -k -t yaac:codex 'codex .* --yolo'/)
    // Then probes that the new agent survived its launch.
    expect(cmds()).toHaveLength(3)
  })

  it('boots the new agent under the spare\'s own id, with the requested model and posture', async () => {
    await retoolSpare({ ...SPARE, tool: 'codex' }, {
      tool: 'claude', model: 'claude-opus-5-5', permissionMode: 'plan', mode: 'tui',
    })

    const respawn = respawnCmd()
    expect(respawn).toContain('-t yaac:claude')
    expect(respawn).toContain('--session-id spare1')
    expect(respawn).toContain('--model claude-opus-5-5')
    expect(respawn).toContain('--permission-mode plan')
  })
})

describe('rebranchSpare', () => {
  it('resets by SHA, records the tip as the branch\'s origin ref, and skips mount points in the clean', async () => {
    // Cleaning a mount point fails with EBUSY and would empty its backing
    // dir. Mounts outside /workspace are out of the clean's reach.
    await writeConfig({
      ephemeralModulesPaths: ['packages/web/node_modules'],
      cacheVolumes: { pip: '/workspace/.pip-cache', home: '/home/yaac/.cache/x' },
    })

    await rebranchSpare(SPARE, 'release/2.x', 'abc123', null)

    expect(execs).toEqual([
      // reset+clean walks the whole checkout, so it gets a longer timeout.
      {
        cmd: 'sh -c "git -C /workspace reset --hard abc123 && git -C /workspace clean -fd'
          + ' -e \'packages/web/node_modules\' -e \'.pip-cache\'"',
        timeout: 120_000,
      },
      // The clone's origin refs are a snapshot that may predate the branch.
      {
        cmd: "git -C /workspace update-ref 'refs/remotes/origin/release/2.x' abc123"
          + " && git -C /workspace branch --set-upstream-to 'origin/release/2.x'",
      },
    ])
  })

  it('excludes the default node_modules mount when the config names none', async () => {
    await rebranchSpare(SPARE, 'dev', 'abc123', null)
    expect(cmds()[0]).toBe(
      'sh -c "git -C /workspace reset --hard abc123 && git -C /workspace clean -fd -e \'node_modules\'"',
    )
  })

  it('recreates each init window in one exec with its kill, then respawns the agent last', async () => {
    // Pairing the kill with the create makes a re-run a no-op. A second
    // `sh -c "…"` wrapper would let a command's own `"` end the string early.
    await writeConfig({
      initCommands: [
        { name: 'api', commands: ['pnpm run "build:dev"'] },
        { name: 'web', commands: ['pnpm web'], hidePane: true },
      ],
    })

    await rebranchSpare(SPARE, 'dev', 'abc123', {
      tool: 'claude', model: 'claude-opus-5-5', permissionMode: 'plan', mode: 'tui',
    })

    expect(cmds().slice(2, 4)).toEqual([
      `${TMUX} kill-window -t yaac:api 2>/dev/null; `
      + initWindowCommand({ name: 'api', cmd: 'pnpm run "build:dev"', hidePane: false }, PATHS),
      `${TMUX} kill-window -t yaac:web 2>/dev/null; `
      + initWindowCommand({ name: 'web', cmd: 'pnpm web', hidePane: true }, PATHS),
    ])
    expect(cmds()[2]).toContain(`'cd /workspace && pnpm run "build:dev"'`)
    // Restarted with the model and posture the spare was warmed with, then
    // probed.
    expect(cmds()[4]).toContain('respawn-window -k -t yaac:claude')
    expect(cmds()[4]).toContain('--session-id spare1')
    expect(cmds()[4]).toContain('--model claude-opus-5-5')
    expect(cmds()[4]).toContain('--permission-mode plan')
    expect(cmds()).toHaveLength(6)
  })

  it('respawns a chat spare as acpd on the tool\'s adapter', async () => {
    await rebranchSpare(SPARE, 'dev', 'abc123', {
      tool: 'claude', model: 'claude-opus-5-5', permissionMode: 'bypass', mode: 'acp',
    })
    const respawn = respawnCmd()
    expect(respawn).toContain('respawn-window -k -t yaac:claude')
    expect(respawn).toContain('acpd')
    expect(respawn).not.toContain('--session-id')
  })
})
