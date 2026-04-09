import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DOCKERFILES_DIR } from '@/lib/paths'

describe('image-builder prerequisites', () => {
  it('Dockerfile.base exists in the package', async () => {
    const dockerfilePath = path.join(DOCKERFILES_DIR, 'Dockerfile.base')
    const content = await fs.readFile(dockerfilePath, 'utf8')
    expect(content).toContain('FROM docker.io/ubuntu:24.04')
    expect(content).toContain('claude.ai/install.sh')
    expect(content).toContain('gh')
    expect(content).toContain('tmux')
  })

  it('Dockerfile.base uses yaac user', async () => {
    const dockerfilePath = path.join(DOCKERFILES_DIR, 'Dockerfile.base')
    const content = await fs.readFile(dockerfilePath, 'utf8')
    expect(content).toContain('useradd')
    expect(content).toContain('USER yaac')
  })

  it('Dockerfile.base has sleep infinity entrypoint', async () => {
    const dockerfilePath = path.join(DOCKERFILES_DIR, 'Dockerfile.base')
    const content = await fs.readFile(dockerfilePath, 'utf8')
    expect(content).toContain('sleep')
    expect(content).toContain('infinity')
  })
})
