import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getProjectsDir, workspaceDir } from '@yaac/shared/project-paths'

import { moveLegacyWorkspacesDirs } from '#domain/projects'

describe('moveLegacyWorkspacesDirs', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('moves worktrees/ to workspaces/ behind a link, once, and skips projects without one', async () => {
    const legacy = path.join(getProjectsDir(), 'old', 'worktrees')
    await fs.mkdir(path.join(legacy, 'w1'), { recursive: true })
    await fs.writeFile(path.join(legacy, 'w1', 'f'), 'x')
    await fs.mkdir(path.join(getProjectsDir(), 'new', 'workspaces', 'w2'), { recursive: true })

    await moveLegacyWorkspacesDirs()
    await moveLegacyWorkspacesDirs()

    expect(await fs.readFile(path.join(workspaceDir('old', 'w1'), 'f'), 'utf8')).toBe('x')
    expect(await fs.readlink(legacy)).toBe('workspaces')
    expect(await fs.readFile(path.join(legacy, 'w1', 'f'), 'utf8')).toBe('x')
    expect(await fs.readdir(path.join(getProjectsDir(), 'new'))).toEqual(['workspaces'])
  })

  it('finishes a move a dead start left halfway, and skips a project it cannot move', async () => {
    // Died between the dir's rename and the link's: the waiting link goes in.
    const halfway = path.join(getProjectsDir(), 'halfway')
    await fs.mkdir(path.join(halfway, 'workspaces', 'w1'), { recursive: true })
    await fs.symlink('workspaces', path.join(halfway, 'worktrees.link'))
    // A real dir at both names: logged and left, not fatal to the others.
    const both = path.join(getProjectsDir(), 'both')
    await fs.mkdir(path.join(both, 'worktrees', 'w2'), { recursive: true })
    await fs.mkdir(path.join(both, 'workspaces', 'w3'), { recursive: true })
    const later = path.join(getProjectsDir(), 'later', 'worktrees')
    await fs.mkdir(path.join(later, 'w4'), { recursive: true })

    await moveLegacyWorkspacesDirs()

    expect((await fs.readdir(halfway)).sort()).toEqual(['workspaces', 'worktrees'])
    expect(await fs.readlink(path.join(halfway, 'worktrees'))).toBe('workspaces')
    expect(await fs.readdir(path.join(both, 'worktrees'))).toEqual(['w2'])
    expect(await fs.readlink(later)).toBe('workspaces')
  })
})
