import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir, projectDir, projectConfigDir } from '@yaac/shared/project-paths'
import { withPortForward, addPortForwardToProjectConfig } from '#features/projects/local-config'
import type { YaacConfig } from '@yaac/shared/types'

describe('withPortForward', () => {
  it('appends an entry with hostPortStart at the container port', () => {
    expect(withPortForward({}, 8090))
      .toEqual({ portForward: [{ containerPort: 8090, hostPortStart: 8090 }] })
    expect(withPortForward({ portForward: [{ containerPort: 3000, hostPortStart: 20000 }] }, 8090))
      .toEqual({ portForward: [
        { containerPort: 3000, hostPortStart: 20000 },
        { containerPort: 8090, hostPortStart: 8090 },
      ] })
  })

  it('is a no-op (returns the same object) when the container port is already forwarded', () => {
    const config = { portForward: [{ containerPort: 8090, hostPortStart: 20000 }] }
    expect(withPortForward(config, 8090)).toBe(config)
  })

  it('preserves unrelated config fields', () => {
    expect(withPortForward({ nestedContainers: true }, 8090))
      .toEqual({ nestedContainers: true, portForward: [{ containerPort: 8090, hostPortStart: 8090 }] })
  })
})

describe('addPortForwardToProjectConfig', () => {
  let tmp: string
  const slug = 'proj'

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-port-forward-test-'))
    setDataDir(tmp)
    await fs.mkdir(projectDir(slug), { recursive: true })
    await fs.writeFile(path.join(projectDir(slug), 'project.json'), '{}')
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  const overlayPath = (): string => path.join(projectConfigDir(slug), 'yaac-config.json')

  async function readOverlay(): Promise<YaacConfig> {
    return JSON.parse(await fs.readFile(overlayPath(), 'utf8')) as YaacConfig
  }

  it('persists a new forward, is idempotent, and appends further ports', async () => {
    await addPortForwardToProjectConfig(slug, 8090)
    expect(await readOverlay()).toEqual({ portForward: [{ containerPort: 8090, hostPortStart: 8090 }] })

    await addPortForwardToProjectConfig(slug, 8090) // dedup no-op
    await addPortForwardToProjectConfig(slug, 3000)
    expect((await readOverlay()).portForward).toEqual([
      { containerPort: 8090, hostPortStart: 8090 },
      { containerPort: 3000, hostPortStart: 3000 },
    ])
  })

  it('preserves an existing overlay and its other fields', async () => {
    await fs.mkdir(projectConfigDir(slug), { recursive: true })
    await fs.writeFile(overlayPath(), JSON.stringify({
      hideInitPane: true,
      portForward: [{ containerPort: 3000, hostPortStart: 20000 }],
    }))
    await addPortForwardToProjectConfig(slug, 8090)
    expect(await readOverlay()).toEqual({
      hideInitPane: true,
      portForward: [
        { containerPort: 3000, hostPortStart: 20000 },
        { containerPort: 8090, hostPortStart: 8090 },
      ],
    })
  })

  it('rejects a malformed stored overlay as VALIDATION', async () => {
    await fs.mkdir(projectConfigDir(slug), { recursive: true })
    await fs.writeFile(overlayPath(), '{"portForward": "not-an-array"}')
    await expect(addPortForwardToProjectConfig(slug, 8090))
      .rejects.toThrow('portForward must be an array')
  })
})
