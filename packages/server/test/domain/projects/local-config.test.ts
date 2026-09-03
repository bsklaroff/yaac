import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { projectConfigDir, getProjectsDir } from '@yaac/shared/project-paths'
import { addAllowedHostToProjectConfig, addPortForwardToProjectConfig, readProjectConfigRaw, removeProjectConfig, setProjectReferenceBranch, writeProjectConfig } from '#domain/projects'
import type { ProjectMeta, YaacConfig } from '@yaac/shared/types'

const slug = 'demo'
let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  const dir = path.join(getProjectsDir(), slug)
  await fs.mkdir(dir, { recursive: true })
  const meta: ProjectMeta = {
    slug,
    remoteUrl: 'https://example.com/foo',
    addedAt: '2026-01-01T00:00:00.000Z',
  }
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta))
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

const overlayPath = (): string => path.join(projectConfigDir(slug), 'yaac-config.json')

async function readOverlay(): Promise<YaacConfig> {
  return JSON.parse(await fs.readFile(overlayPath(), 'utf8')) as YaacConfig
}

/** Seed the stored overlay directly, bypassing the validating writer — the
 *  starting state each read-modify-write case builds on. */
async function seedOverlay(raw: string): Promise<void> {
  await fs.mkdir(projectConfigDir(slug), { recursive: true })
  await fs.writeFile(overlayPath(), raw)
}

describe('writeProjectConfig', () => {
  it('writes the parsed config to disk and returns it', async () => {
    const saved = await writeProjectConfig(slug, { initCommands: ['pnpm install'] })
    expect(saved).toEqual({ initCommands: ['pnpm install'] })
    expect(await readOverlay()).toEqual({ initCommands: ['pnpm install'] })
  })

  it('throws NOT_FOUND when the project does not exist', async () => {
    await expect(writeProjectConfig('missing', {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('throws VALIDATION for malformed config', async () => {
    await expect(writeProjectConfig(slug, { initCommands: 'not-array' }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('readProjectConfigRaw', () => {
  it('throws NOT_FOUND when the project does not exist', async () => {
    await expect(readProjectConfigRaw('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it("returns '' when the project has no config file", async () => {
    expect(await readProjectConfigRaw(slug)).toBe('')
  })

  it('returns malformed content verbatim (the repair flow depends on it)', async () => {
    await seedOverlay('{ broken')
    expect(await readProjectConfigRaw(slug)).toBe('{ broken')
  })
})

describe('removeProjectConfig', () => {
  it('throws NOT_FOUND when the project does not exist', async () => {
    await expect(removeProjectConfig('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('removes only yaac-config.json, keeping the rest of the config dir', async () => {
    await writeProjectConfig(slug, { initCommands: ['pnpm build'] })
    const dockerfile = path.join(projectConfigDir(slug), 'build', 'Dockerfile.yaac')
    await fs.mkdir(path.dirname(dockerfile), { recursive: true })
    await fs.writeFile(dockerfile, 'FROM ubuntu\n')

    await removeProjectConfig(slug)

    await expect(fs.access(overlayPath())).rejects.toThrow()
    expect(await fs.readFile(dockerfile, 'utf8')).toBe('FROM ubuntu\n')
  })

  it('is a no-op when no config dir exists', async () => {
    await removeProjectConfig(slug)
  })
})

describe('addAllowedHostToProjectConfig', () => {
  it('persists a new host, is idempotent, and appends further hosts', async () => {
    await addAllowedHostToProjectConfig(slug, 'new.example.com')
    expect(await readOverlay()).toEqual({ addAllowedUrls: ['new.example.com'] })

    await addAllowedHostToProjectConfig(slug, 'new.example.com') // dedup no-op
    await addAllowedHostToProjectConfig(slug, 'other.example.com')
    expect((await readOverlay()).addAllowedUrls)
      .toEqual(['new.example.com', 'other.example.com'])
  })

  it('appends to setAllowedUrls when the stored overlay pins an exact list', async () => {
    await seedOverlay(JSON.stringify({ setAllowedUrls: ['pinned.com'] }))
    await addAllowedHostToProjectConfig(slug, 'extra.com')
    expect(await readOverlay()).toEqual({ setAllowedUrls: ['pinned.com', 'extra.com'] })

    await addAllowedHostToProjectConfig(slug, 'pinned.com') // dedup no-op
    expect((await readOverlay()).setAllowedUrls).toEqual(['pinned.com', 'extra.com'])
  })

  it('preserves unrelated fields of the stored overlay', async () => {
    await seedOverlay(JSON.stringify({ nestedContainers: true }))
    await addAllowedHostToProjectConfig(slug, 'a.com')
    expect(await readOverlay()).toEqual({ nestedContainers: true, addAllowedUrls: ['a.com'] })
  })

  it('rejects a malformed stored overlay as VALIDATION', async () => {
    await seedOverlay('{"addAllowedUrls": "not-an-array"}')
    await expect(addAllowedHostToProjectConfig(slug, 'x.com'))
      .rejects.toThrow('addAllowedUrls must be a string array')
  })
})

describe('addPortForwardToProjectConfig', () => {
  it('persists a new forward with hostPortStart at the container port, and dedups', async () => {
    await addPortForwardToProjectConfig(slug, 8090)
    expect(await readOverlay()).toEqual({ portForward: [{ containerPort: 8090, hostPortStart: 8090 }] })

    await addPortForwardToProjectConfig(slug, 8090) // dedup no-op
    await addPortForwardToProjectConfig(slug, 3000)
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
    await seedOverlay('{"portForward": "not-an-array"}')
    await expect(addPortForwardToProjectConfig(slug, 8090))
      .rejects.toThrow('portForward must be an array')
  })
})

describe('setProjectReferenceBranch', () => {
  it('persists set, overwrite, and clear round-trips through the validating writer', async () => {
    await seedOverlay(JSON.stringify({ hideInitPane: true }))

    const set = await setProjectReferenceBranch(slug, 'develop')
    expect(set).toEqual({ hideInitPane: true, referenceBranch: 'develop' })
    expect((await readOverlay()).referenceBranch).toBe('develop')

    const moved = await setProjectReferenceBranch(slug, 'release/2.x')
    expect(moved.referenceBranch).toBe('release/2.x')

    const cleared = await setProjectReferenceBranch(slug, null)
    expect(cleared).toEqual({ hideInitPane: true })
    expect((await readOverlay()).referenceBranch).toBeUndefined()
  })

  it('rejects malformed branch names via the config parser', async () => {
    await expect(setProjectReferenceBranch(slug, 'origin/develop'))
      .rejects.toThrow(/drop the "origin\/" prefix/)
  })

  it('throws NOT_FOUND for an unknown project', async () => {
    await expect(setProjectReferenceBranch('nope', 'develop'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects a malformed stored overlay as VALIDATION', async () => {
    await seedOverlay('{"referenceBranch": 5}')
    await expect(setProjectReferenceBranch(slug, 'develop'))
      .rejects.toThrow(/non-empty string/)
  })
})
