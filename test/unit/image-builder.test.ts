import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DOCKERFILES_DIR } from '@/lib/paths'

describe('image-builder prerequisites', () => {
  it('Dockerfile.default exists in the package', async () => {
    const dockerfilePath = path.join(DOCKERFILES_DIR, 'Dockerfile.default')
    const content = await fs.readFile(dockerfilePath, 'utf8')
    expect(content).toContain('FROM docker.io/ubuntu:24.04')
    expect(content).toContain('claude.ai/install.sh')
    expect(content).toContain('gh')
    expect(content).toContain('tmux')
  })

  it('Dockerfile.default runs as non-root yaac user', async () => {
    const dockerfilePath = path.join(DOCKERFILES_DIR, 'Dockerfile.default')
    const content = await fs.readFile(dockerfilePath, 'utf8')
    expect(content).toContain('useradd')
    expect(content).toContain('USER yaac')
  })

  it('Dockerfile.default has sleep infinity entrypoint', async () => {
    const dockerfilePath = path.join(DOCKERFILES_DIR, 'Dockerfile.default')
    const content = await fs.readFile(dockerfilePath, 'utf8')
    expect(content).toContain('sleep')
    expect(content).toContain('infinity')
  })

  it('Dockerfile.nestable defaults to yaac-base as base image', async () => {
    const dockerfilePath = path.join(DOCKERFILES_DIR, 'Dockerfile.nestable')
    const content = await fs.readFile(dockerfilePath, 'utf8')
    expect(content).toContain('BASE_IMAGE=yaac-base')
  })

  it('Dockerfile.nestable configures podman-in-podman support', async () => {
    const dockerfilePath = path.join(DOCKERFILES_DIR, 'Dockerfile.nestable')
    const content = await fs.readFile(dockerfilePath, 'utf8')
    expect(content).toContain('subuid')
    expect(content).toContain('subgid')
    expect(content).toContain('setcap')
    expect(content).toContain('containers.conf')
    expect(content).toContain('_CONTAINERS_USERNS_CONFIGURED')
  })
})
