import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createYaacTestEnv, spawnYaacDaemon, runYaac, type YaacTestEnv, type SpawnedDaemon } from '@test/helpers/cli'
import { createTestRepo, addTestProject } from '@test/helpers/setup'
import { makeDaemonRpcClient } from '@test/helpers/rpc'

describe('yaac config (real CLI + real daemon)', () => {
  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
    daemon = await spawnYaacDaemon(testEnv.env)
  })

  afterEach(async () => {
    await daemon.stop()
    await testEnv.cleanup()
  })

  // Stand-in editor: a tiny shell script that writes a deterministic
  // marker into whichever file path the CLI hands it. Lets us assert
  // the right file path was opened without spawning a real editor.
  async function writeMarkerEditor(marker: string): Promise<string> {
    const editorPath = path.join(testEnv.scratchDir, `editor-${marker}.sh`)
    await fs.writeFile(editorPath, `#!/bin/sh\nprintf %s '${marker}' > "$1"\n`, { mode: 0o755 })
    return editorPath
  }

  it('config edit opens yaac-config.json under the project config dir', async () => {
    const repo = path.join(testEnv.scratchDir, 'demo')
    await createTestRepo(repo)
    await addTestProject(repo)

    const editor = await writeMarkerEditor('yaac-config-marker')
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit', 'demo',
    )
    expect(exitCode, stderr).toBe(0)

    const target = path.join(testEnv.dataDir, 'projects', 'demo', 'config', 'yaac-config.json')
    expect(await fs.readFile(target, 'utf8')).toBe('yaac-config-marker')
  })

  it('config edit-dockerfile opens Dockerfile.yaac under the project config dir', async () => {
    const repo = path.join(testEnv.scratchDir, 'demo')
    await createTestRepo(repo)
    await addTestProject(repo)

    const editor = await writeMarkerEditor('dockerfile-marker')
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit-dockerfile', 'demo',
    )
    expect(exitCode, stderr).toBe(0)

    const target = path.join(testEnv.dataDir, 'projects', 'demo', 'config', 'Dockerfile.yaac')
    expect(await fs.readFile(target, 'utf8')).toBe('dockerfile-marker')
  })

  it('config edit-user-dockerfile opens the global Dockerfile.user', async () => {
    const editor = await writeMarkerEditor('user-dockerfile-marker')
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit-user-dockerfile',
    )
    expect(exitCode, stderr).toBe(0)

    const target = path.join(testEnv.dataDir, 'Dockerfile.user')
    expect(await fs.readFile(target, 'utf8')).toBe('user-dockerfile-marker')
  })

  it('config edit opens the editor even when yaac-config.json is malformed', async () => {
    const repo = path.join(testEnv.scratchDir, 'demo')
    await createTestRepo(repo)
    await addTestProject(repo)

    const target = path.join(testEnv.dataDir, 'projects', 'demo', 'config', 'yaac-config.json')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, '{ this is not valid json')

    const editor = await writeMarkerEditor('repaired-config')
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit', 'demo',
    )
    expect(exitCode, stderr).toBe(0)
    expect(await fs.readFile(target, 'utf8')).toBe('repaired-config')
  })

  it('accepts the nestedContainers key through the config-write route', async () => {
    // The daemon's config-write route runs the same parser session-create
    // hits at load time; `nestedContainers` must parse cleanly.
    const repo = path.join(testEnv.scratchDir, 'demo')
    await createTestRepo(repo)
    await addTestProject(repo)

    const client = makeDaemonRpcClient(daemon)

    const nested = await client.project[':slug'].config.$put({
      param: { slug: 'demo' },
      json: { config: { nestedContainers: true } },
    })
    expect(nested.status).toBe(200)
  })

  it('config edit fails with a clear error for an unknown project slug', async () => {
    const editor = await writeMarkerEditor('should-not-run')
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit', 'no-such-project',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/no-such-project|not found/i)
  })
})
