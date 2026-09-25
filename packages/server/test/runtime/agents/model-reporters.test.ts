import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureModelReporters } from '#runtime/agents/model-reporters'

describe('ensureModelReporters', () => {
  let dir: string
  let homes: { piAgentDir: string; opencodeConfigDir: string }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-reporters-'))
    homes = { piAgentDir: path.join(dir, 'pi', 'agent'), opencodeConfigDir: path.join(dir, 'opencode') }
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('puts each reporter where its tool loads extensions from, and settles', async () => {
    await ensureModelReporters(homes)

    // pi auto-discovers `$PI_CODING_AGENT_DIR/extensions/*.ts`; it reports on
    // the switch itself and, for startup and resume, on session start.
    const pi = await fs.readFile(path.join(homes.piAgentDir, 'extensions', 'yaac-model.ts'), 'utf8')
    expect(pi).toContain("pi.on('model_select'")
    expect(pi).toContain("pi.on('session_start'")
    expect(pi).toContain("pi.exec('yaac-agent-model'")

    // opencode loads a plugin DIRECTORY (a file path is refused), resolving
    // its server entry by name — `index`.
    const plugin = path.join(homes.opencodeConfigDir, 'yaac-model')
    const source = await fs.readFile(path.join(plugin, 'index.ts'), 'utf8')
    for (const event of ['session.model.selected', 'session.created', 'session.step.started']) {
      expect(source).toContain(`'${event}'`)
    }

    // A second create finds the bytes in place and rewrites nothing — the
    // files are read at startup by every worktree of the project.
    const before = (await fs.stat(path.join(plugin, 'index.ts'))).mtimeMs
    await new Promise((r) => setTimeout(r, 20))
    await ensureModelReporters(homes)
    expect((await fs.stat(path.join(plugin, 'index.ts'))).mtimeMs).toBe(before)
    expect(await fs.readdir(plugin)).toEqual(['index.ts'])
  })
})
