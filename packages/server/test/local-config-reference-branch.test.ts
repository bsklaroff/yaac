import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir, projectDir, projectConfigDir } from '@yaac/shared/project-paths'
import { withReferenceBranch, setProjectReferenceBranch } from '#lib/project/local-config'
import type { YaacConfig } from '@yaac/shared/types'

describe('withReferenceBranch', () => {
  it('sets the branch, preserving unrelated fields', () => {
    expect(withReferenceBranch({ nestedContainers: true }, 'develop'))
      .toEqual({ nestedContainers: true, referenceBranch: 'develop' })
  })

  it('overwrites an existing branch', () => {
    expect(withReferenceBranch({ referenceBranch: 'develop' }, 'release/2.x'))
      .toEqual({ referenceBranch: 'release/2.x' })
  })

  it('clears the field with null', () => {
    expect(withReferenceBranch({ referenceBranch: 'develop', hideInitPane: true }, null))
      .toEqual({ hideInitPane: true })
  })
})

describe('setProjectReferenceBranch', () => {
  let tmp: string
  const slug = 'proj'

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ref-branch-test-'))
    setDataDir(tmp)
    await fs.mkdir(projectDir(slug), { recursive: true })
    await fs.writeFile(path.join(projectDir(slug), 'project.json'), '{}')
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  async function readOverlay(): Promise<YaacConfig> {
    return JSON.parse(
      await fs.readFile(path.join(projectConfigDir(slug), 'yaac-config.json'), 'utf8'),
    ) as YaacConfig
  }

  it('persists set and clear round-trips through the validating writer', async () => {
    const set = await setProjectReferenceBranch(slug, 'develop')
    expect(set.referenceBranch).toBe('develop')
    expect((await readOverlay()).referenceBranch).toBe('develop')

    const cleared = await setProjectReferenceBranch(slug, null)
    expect(cleared.referenceBranch).toBeUndefined()
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
})
