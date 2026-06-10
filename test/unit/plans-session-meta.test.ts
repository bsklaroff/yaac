import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { projectDir } from '@/lib/project/paths'
import {
  planSessionMetaFile,
  savePlanSessionMeta,
  loadPlanSessionMeta,
} from '@/lib/plans/session-meta'

describe('plan session meta', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('planSessionMetaFile lives under the session dir', () => {
    expect(planSessionMetaFile('proj', 'sid')).toBe(
      path.join(projectDir('proj'), 'sessions', 'sid', 'plans-meta.json'),
    )
  })

  it('save + load round-trips role and doc', async () => {
    await savePlanSessionMeta('proj', 'sid', { role: 'build', doc: 'x.md' })
    expect(await loadPlanSessionMeta('proj', 'sid')).toEqual({ role: 'build', doc: 'x.md' })
  })

  it('load returns null for missing or malformed files', async () => {
    expect(await loadPlanSessionMeta('proj', 'nope')).toBeNull()
    const file = planSessionMetaFile('proj', 'bad')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{"role":"owner","doc":3}')
    expect(await loadPlanSessionMeta('proj', 'bad')).toBeNull()
    await fs.writeFile(file, 'not json')
    expect(await loadPlanSessionMeta('proj', 'bad')).toBeNull()
  })
})
