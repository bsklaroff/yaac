import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir, projectDir, projectConfigDir } from '@/lib/project/paths'
import { withAllowedHost, addAllowedHostToProjectConfig } from '@/lib/project/local-config'
import type { YaacConfig } from '@/shared/types'

describe('withAllowedHost', () => {
  it('appends to addAllowedUrls by default', () => {
    expect(withAllowedHost({}, 'a.com')).toEqual({ addAllowedUrls: ['a.com'] })
    expect(withAllowedHost({ addAllowedUrls: ['a.com'] }, 'b.com'))
      .toEqual({ addAllowedUrls: ['a.com', 'b.com'] })
  })

  it('appends to setAllowedUrls when the project pins an exact list', () => {
    expect(withAllowedHost({ setAllowedUrls: ['a.com'] }, 'b.com'))
      .toEqual({ setAllowedUrls: ['a.com', 'b.com'] })
  })

  it('is a no-op (returns the same object) when the host is already present', () => {
    const add = { addAllowedUrls: ['a.com'] }
    expect(withAllowedHost(add, 'a.com')).toBe(add)
    const set = { setAllowedUrls: ['a.com'] }
    expect(withAllowedHost(set, 'a.com')).toBe(set)
  })

  it('preserves unrelated config fields', () => {
    expect(withAllowedHost({ nestedContainers: true }, 'a.com'))
      .toEqual({ nestedContainers: true, addAllowedUrls: ['a.com'] })
  })
})

describe('addAllowedHostToProjectConfig', () => {
  let tmp: string
  const slug = 'proj'

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-allow-host-test-'))
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

  it('persists a new host, is idempotent, and appends further hosts', async () => {
    await addAllowedHostToProjectConfig(slug, 'new.example.com')
    expect(await readOverlay()).toEqual({ addAllowedUrls: ['new.example.com'] })

    await addAllowedHostToProjectConfig(slug, 'new.example.com') // dedup no-op
    await addAllowedHostToProjectConfig(slug, 'other.example.com')
    expect((await readOverlay()).addAllowedUrls)
      .toEqual(['new.example.com', 'other.example.com'])
  })

  it('appends to setAllowedUrls when the stored overlay pins an exact list', async () => {
    await fs.mkdir(projectConfigDir(slug), { recursive: true })
    await fs.writeFile(overlayPath(), JSON.stringify({ setAllowedUrls: ['pinned.com'] }))
    await addAllowedHostToProjectConfig(slug, 'extra.com')
    expect(await readOverlay()).toEqual({ setAllowedUrls: ['pinned.com', 'extra.com'] })
  })

  it('rejects a malformed stored overlay as VALIDATION', async () => {
    await fs.mkdir(projectConfigDir(slug), { recursive: true })
    await fs.writeFile(overlayPath(), '{"addAllowedUrls": "not-an-array"}')
    await expect(addAllowedHostToProjectConfig(slug, 'x.com'))
      .rejects.toThrow('addAllowedUrls must be a string array')
  })
})
