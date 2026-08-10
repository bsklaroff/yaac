import { describe, it, expect } from 'vitest'
import { buildRebranchPrep } from '#features/worktrees/spare-pool'
import { initWindowCommand } from '#runtime/agents/agent-command'
import { CONTAINER_TMUX_SOCK } from '@yaac/shared/paths'

const TMUX = `tmux -S ${CONTAINER_TMUX_SOCK}`

describe('buildRebranchPrep', () => {
  it('resets by SHA and cleans without -x, excluding the default node_modules mount', () => {
    const prep = buildRebranchPrep({
      branch: 'dev', sha: 'abc123', config: {}, worktreeId: 's1', respawnTool: null,
    })
    expect(prep.resetExec).toBe(
      'sh -c "git -C /workspace reset --hard abc123 && git -C /workspace clean -fd'
      + ' -e \'node_modules\'"',
    )
  })

  it('excludes every workspace mount point from the clean', () => {
    // Mount points are live directories in the pod — cleaning one fails
    // with EBUSY (and would empty its backing dir), so each is excluded.
    const prep = buildRebranchPrep({
      branch: 'dev',
      sha: 'abc123',
      config: {
        ephemeralModulesPaths: ['packages/web/node_modules'],
        cacheVolumes: { pip: '/workspace/.pip-cache', home: '/home/yaac/.cache/x' },
        bindMounts: [
          { hostPath: '/data', containerPath: '/workspace/data', mode: 'ro' },
          { hostPath: '/models', containerPath: '/mnt/models', mode: 'rw' },
        ],
      },
      worktreeId: 's1',
      respawnTool: null,
    })
    expect(prep.resetExec).toContain(" -e 'packages/web/node_modules'")
    expect(prep.resetExec).toContain(" -e '.pip-cache'")
    expect(prep.resetExec).toContain(" -e 'data'")
    // Mounts outside /workspace are unreachable by the clean — not excluded.
    expect(prep.resetExec).not.toContain('models')
    expect(prep.resetExec).not.toContain('.cache/x')
  })

  it('rewrites the upstream to the new branch, shell-escaped', () => {
    const prep = buildRebranchPrep({
      branch: 'release/2.x', sha: 'abc123', config: {}, worktreeId: 's1', respawnTool: null,
    })
    expect(prep.upstreamExec).toBe(
      "git -C /workspace branch --set-upstream-to 'origin/release/2.x'",
    )
  })

  it('pairs each kill with its re-create in one exec, so a re-run is a no-op', () => {
    const prep = buildRebranchPrep({
      branch: 'dev',
      sha: 'abc123',
      config: { initCommands: [{ name: 'api', commands: ['pnpm dev'] }, { name: 'web', commands: ['pnpm web'], hidePane: true }] },
      worktreeId: 's1',
      respawnTool: null,
    })
    expect(prep.windowExecs).toEqual([
      `${TMUX} kill-window -t yaac:api 2>/dev/null; `
      + initWindowCommand({ name: 'api', cmd: 'pnpm dev', hidePane: false }),
      `${TMUX} kill-window -t yaac:web 2>/dev/null; `
      + initWindowCommand({ name: 'web', cmd: 'pnpm web', hidePane: true }),
    ])
  })

  it('leaves an init command carrying double quotes intact (one shell pass)', () => {
    // The kill+create pair is joined with `;` rather than wrapped in a
    // second `sh -c "…"`: a wrapper would put the user's command inside
    // double quotes, where its own `"` would end the string early.
    const prep = buildRebranchPrep({
      branch: 'dev',
      sha: 'abc123',
      config: { initCommands: [{ name: 'api', commands: ['pnpm run "build:dev"'] }] },
      worktreeId: 's1',
      respawnTool: null,
    })
    expect(prep.windowExecs[0]).toContain(`'cd /workspace && pnpm run "build:dev"'`)
  })

  it('appends the agent respawn last when requested', () => {
    const prep = buildRebranchPrep({
      branch: 'dev', sha: 'abc123', config: {}, worktreeId: 's1', respawnTool: 'claude',
    })
    expect(prep.windowExecs).toHaveLength(1)
    expect(prep.windowExecs[0]).toContain('respawn-window -k -t yaac:claude')
    expect(prep.windowExecs[0]).toContain('--session-id s1')
  })

  it('emits no window execs when there are no init commands and no respawn', () => {
    const prep = buildRebranchPrep({
      branch: 'dev', sha: 'abc123', config: {}, worktreeId: 's1', respawnTool: null,
    })
    expect(prep.windowExecs).toEqual([])
  })
})
