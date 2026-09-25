import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { ensureAgentReporters } from '#runtime/agents/agent-reporters'

describe('ensureAgentReporters', () => {
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
    await ensureAgentReporters(homes)

    // pi auto-discovers `$PI_CODING_AGENT_DIR/extensions/*.ts`; it reports on
    // the switch itself and, for startup and resume, on session start.
    const pi = await fs.readFile(path.join(homes.piAgentDir, 'extensions', 'yaac-report.ts'), 'utf8')
    expect(pi).toContain("pi.on('model_select'")
    expect(pi).toContain("pi.on('session_start'")
    expect(pi).toContain("pi.exec('yaac-agent-report'")

    // opencode loads a plugin DIRECTORY (a file path is refused), resolving
    // its server entry by name — `index`.
    const plugin = path.join(homes.opencodeConfigDir, 'yaac-report')
    const source = await fs.readFile(path.join(plugin, 'index.ts'), 'utf8')
    for (const event of ['session.model.selected', 'session.created', 'session.step.started']) {
      expect(source).toContain(`'${event}'`)
    }

    // A second create finds the bytes in place and rewrites nothing — the
    // files are read at startup by every worktree of the project.
    const before = (await fs.stat(path.join(plugin, 'index.ts'))).mtimeMs
    await new Promise((r) => setTimeout(r, 20))
    await ensureAgentReporters(homes)
    expect((await fs.stat(path.join(plugin, 'index.ts'))).mtimeMs).toBe(before)
    expect(await fs.readdir(plugin)).toEqual(['index.ts'])
  })

  // The plugin as written, run against the event shapes opencode 2.0.12
  // emits: the agent is half a posture, and a Tab between agents reaches the
  // server only with the next prompt, as `session.agent.selected`. Run in a
  // child node — it is an ES module opencode loads, and the reporter it calls
  // is a stub on that child's PATH.
  it("reports opencode's model and agent together, whenever either moves", async () => {
    await ensureAgentReporters(homes)
    const bin = path.join(dir, 'bin')
    const calls = path.join(dir, 'calls')
    await fs.mkdir(bin)
    await fs.writeFile(path.join(bin, 'yaac-agent-report'),
      `#!/bin/sh\nprintf '%s|%s\\n' "$1" "$2" >> ${calls}\n`, { mode: 0o755 })
    const plugin = path.join(dir, 'plugin.mjs')
    await fs.copyFile(path.join(homes.opencodeConfigDir, 'yaac-report', 'index.ts'), plugin)
    const model = { providerID: 'opencode', id: 'big-pickle' }
    const events = [
      { type: 'session.created', data: { model } },
      { type: 'session.agent.selected', data: { agent: 'plan' } },
      { type: 'session.step.started', data: { agent: 'plan', model } },
      { type: 'session.agent.selected', data: { agent: 'build', previous: 'plan' } },
    ]
    await new Promise<void>((resolve, reject) => {
      execFile(process.execPath, ['--input-type=module', '-e', [
        `const { default: reporter } = await import(${JSON.stringify(plugin)})`,
        `const events = ${JSON.stringify(events)}`,
        'reporter.setup({ event: { subscribe: async function* () { yield* events } } })',
      ].join('\n')], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } },
      (err) => (err ? reject(new Error(err.message)) : resolve()))
    })
    await vi.waitFor(async () => {
      expect((await fs.readFile(calls, 'utf8').catch(() => '')).trim().split('\n'))
        .toEqual(['opencode/big-pickle|', 'opencode/big-pickle|plan', 'opencode/big-pickle|build'])
    })
  })
})
