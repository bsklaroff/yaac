import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { projectConfigDir, getProjectsDir } from '@yaac/shared/project-paths'
import { addAllowedHostToProjectConfig, addPortForwardToProjectConfig, readProjectConfigRaw, removeProjectConfig, writeProjectConfig } from '#domain/projects'
import { recordProject } from '#db'
import { DEMO_PROJECT_ID } from '@yaac/test-utils/project-fixture'
import type { ProjectMeta, YaacConfig } from '@yaac/shared/types'

const MISSING = 'ea21841d-a70e-4405-8f19-fabc4ff8bdd9'

const projectId = DEMO_PROJECT_ID
let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  const dir = path.join(getProjectsDir(), projectId)
  await fs.mkdir(dir, { recursive: true })
  const meta: ProjectMeta = {
    id: projectId,
    name: 'demo',
    remoteUrl: 'https://example.com/foo',
    addedAt: '2026-01-01T00:00:00.000Z',
  }
  await recordProject(meta)
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

const overlayPath = (): string => path.join(projectConfigDir(projectId), 'yaac-config.json')

async function readOverlay(): Promise<YaacConfig> {
  return JSON.parse(await fs.readFile(overlayPath(), 'utf8')) as YaacConfig
}

/** Seed the stored overlay directly, bypassing the validating writer. */
async function seedOverlay(raw: string): Promise<void> {
  await fs.mkdir(projectConfigDir(projectId), { recursive: true })
  await fs.writeFile(overlayPath(), raw)
}

describe('writeProjectConfig', () => {
  it('writes the parsed config to disk and returns it', async () => {
    const saved = await writeProjectConfig(projectId, { initCommands: ['pnpm install'] })
    expect(saved).toEqual({ initCommands: ['pnpm install'] })
    expect(await readOverlay()).toEqual({ initCommands: ['pnpm install'] })
  })

  it('throws NOT_FOUND when the project does not exist', async () => {
    await expect(writeProjectConfig(MISSING, {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('throws VALIDATION for malformed config', async () => {
    await expect(writeProjectConfig(projectId, { initCommands: 'not-array' }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('readProjectConfigRaw', () => {
  it('throws NOT_FOUND when the project does not exist', async () => {
    await expect(readProjectConfigRaw(MISSING)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it("returns '' when the project has no config file", async () => {
    expect(await readProjectConfigRaw(projectId)).toBe('')
  })

  it('returns malformed content verbatim (the repair flow depends on it)', async () => {
    await seedOverlay('{ broken')
    expect(await readProjectConfigRaw(projectId)).toBe('{ broken')
  })
})

describe('removeProjectConfig', () => {
  it('throws NOT_FOUND when the project does not exist', async () => {
    await expect(removeProjectConfig(MISSING)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('removes only yaac-config.json, keeping the rest of the config dir', async () => {
    await writeProjectConfig(projectId, { initCommands: ['pnpm build'] })
    const dockerfile = path.join(projectConfigDir(projectId), 'build', 'Dockerfile.yaac')
    await fs.mkdir(path.dirname(dockerfile), { recursive: true })
    await fs.writeFile(dockerfile, 'FROM ubuntu\n')

    await removeProjectConfig(projectId)

    await expect(fs.access(overlayPath())).rejects.toThrow()
    expect(await fs.readFile(dockerfile, 'utf8')).toBe('FROM ubuntu\n')
  })

  it('is a no-op when no config dir exists', async () => {
    await removeProjectConfig(projectId)
  })
})

describe('addAllowedHostToProjectConfig', () => {
  it('persists a new host, is idempotent, and appends further hosts', async () => {
    await addAllowedHostToProjectConfig(projectId, 'new.example.com')
    expect(await readOverlay()).toEqual({ addAllowedUrls: ['new.example.com'] })

    await addAllowedHostToProjectConfig(projectId, 'new.example.com') // dedup no-op
    await addAllowedHostToProjectConfig(projectId, 'other.example.com')
    expect((await readOverlay()).addAllowedUrls)
      .toEqual(['new.example.com', 'other.example.com'])
  })

  it('appends to setAllowedUrls when the stored overlay pins an exact list', async () => {
    await seedOverlay(JSON.stringify({ setAllowedUrls: ['pinned.com'] }))
    await addAllowedHostToProjectConfig(projectId, 'extra.com')
    expect(await readOverlay()).toEqual({ setAllowedUrls: ['pinned.com', 'extra.com'] })

    await addAllowedHostToProjectConfig(projectId, 'pinned.com') // dedup no-op
    expect((await readOverlay()).setAllowedUrls).toEqual(['pinned.com', 'extra.com'])
  })

  it('preserves unrelated fields of the stored overlay', async () => {
    await seedOverlay(JSON.stringify({ nestedContainers: true }))
    await addAllowedHostToProjectConfig(projectId, 'a.com')
    expect(await readOverlay()).toEqual({ nestedContainers: true, addAllowedUrls: ['a.com'] })
  })

  it('rejects a malformed stored overlay as VALIDATION', async () => {
    await seedOverlay('{"addAllowedUrls": "not-an-array"}')
    await expect(addAllowedHostToProjectConfig(projectId, 'x.com'))
      .rejects.toThrow('addAllowedUrls must be a string array')
  })
})

describe('addPortForwardToProjectConfig', () => {
  it('persists a new forward with hostPortStart at the container port, and dedups', async () => {
    await addPortForwardToProjectConfig(projectId, 8090)
    expect(await readOverlay()).toEqual({ portForward: [{ containerPort: 8090, hostPortStart: 8090 }] })

    await addPortForwardToProjectConfig(projectId, 8090) // dedup no-op
    await addPortForwardToProjectConfig(projectId, 3000)
    expect((await readOverlay()).portForward).toEqual([
      { containerPort: 8090, hostPortStart: 8090 },
      { containerPort: 3000, hostPortStart: 3000 },
    ])
  })

  it('preserves an existing overlay, its hand-picked host ports, and its other fields', async () => {
    await seedOverlay(JSON.stringify({
      hideInitPane: true,
      portForward: [{ containerPort: 3000, hostPortStart: 20000 }],
    }))
    await addPortForwardToProjectConfig(projectId, 8090)
    expect(await readOverlay()).toEqual({
      hideInitPane: true,
      portForward: [
        { containerPort: 3000, hostPortStart: 20000 },
        { containerPort: 8090, hostPortStart: 8090 },
      ],
    })
  })

  it('rejects a malformed stored overlay as VALIDATION', async () => {
    await seedOverlay('{"portForward": "not-an-array"}')
    await expect(addPortForwardToProjectConfig(projectId, 8090))
      .rejects.toThrow('portForward must be an array')
  })
})
