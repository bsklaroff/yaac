import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DOCKERFILES_DIR } from '@/lib/project/paths'
import { baseImageHash, contextHash, fileHash, sessionUid } from '@/lib/container/image-builder'

describe('fileHash', () => {
  it('produces a 16-char hex hash of file contents', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-fh-'))
    try {
      const filePath = path.join(tmpDir, 'test.txt')
      await fs.writeFile(filePath, 'hello world')
      const hash = await fileHash(filePath)
      expect(hash).toMatch(/^[0-9a-f]{16}$/)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns same hash for same content', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-fh-'))
    try {
      const a = path.join(tmpDir, 'a.txt')
      const b = path.join(tmpDir, 'b.txt')
      await fs.writeFile(a, 'same content')
      await fs.writeFile(b, 'same content')
      expect(await fileHash(a)).toBe(await fileHash(b))
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('sessionUid', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('mirrors the daemon process uid', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(501)
    expect(sessionUid()).toBe(501)
  })

  it('falls back to 1000 when the daemon runs as root (uid 0 is taken in the image)', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0)
    expect(sessionUid()).toBe(1000)
  })
})

describe('baseImageHash', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('folds the session uid into the Dockerfile content hash', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-bih-'))
    try {
      const dockerfile = path.join(tmpDir, 'Dockerfile')
      await fs.writeFile(dockerfile, 'FROM scratch')

      vi.spyOn(process, 'getuid').mockReturnValue(501)
      const hash501 = await baseImageHash(dockerfile)
      vi.spyOn(process, 'getuid').mockReturnValue(1000)
      const hash1000 = await baseImageHash(dockerfile)

      expect(hash501).toMatch(/^[0-9a-f]{16}$/)
      // A uid change must invalidate the tag like a Dockerfile edit would.
      expect(hash501).not.toBe(hash1000)
      expect(hash501).not.toBe(await fileHash(dockerfile))
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('contextHash', () => {
  it('produces deterministic hash from directory contents', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ctx-'))
    try {
      await fs.writeFile(path.join(tmpDir, 'a.txt'), 'hello')
      await fs.writeFile(path.join(tmpDir, 'b.txt'), 'world')

      const hash1 = await contextHash(tmpDir)
      const hash2 = await contextHash(tmpDir)
      expect(hash1).toBe(hash2)
      expect(hash1).toHaveLength(16)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('changes when file content changes', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ctx-'))
    try {
      await fs.writeFile(path.join(tmpDir, 'a.txt'), 'hello')
      const hash1 = await contextHash(tmpDir)

      await fs.writeFile(path.join(tmpDir, 'a.txt'), 'changed')
      const hash2 = await contextHash(tmpDir)

      expect(hash2).not.toBe(hash1)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('changes when a file is added', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ctx-'))
    try {
      await fs.writeFile(path.join(tmpDir, 'a.txt'), 'hello')
      const hash1 = await contextHash(tmpDir)

      await fs.writeFile(path.join(tmpDir, 'b.txt'), 'world')
      const hash2 = await contextHash(tmpDir)

      expect(hash2).not.toBe(hash1)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('changes when a file is added in a subdirectory', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ctx-'))
    try {
      await fs.writeFile(path.join(tmpDir, 'a.txt'), 'hello')
      const hash1 = await contextHash(tmpDir)

      await fs.mkdir(path.join(tmpDir, 'subdir'))
      await fs.writeFile(path.join(tmpDir, 'subdir', 'b.txt'), 'world')
      const hash2 = await contextHash(tmpDir)

      expect(hash2).not.toBe(hash1)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('ignores node_modules', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ctx-'))
    try {
      await fs.writeFile(path.join(tmpDir, 'a.txt'), 'hello')
      const hash1 = await contextHash(tmpDir)

      await fs.mkdir(path.join(tmpDir, 'node_modules'))
      await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg.txt'), 'noise')
      const hash2 = await contextHash(tmpDir)

      expect(hash2).toBe(hash1)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('image-builder prerequisites', () => {
  it('Dockerfile.default exists in the package', async () => {
    const dockerfilePath = path.join(DOCKERFILES_DIR, 'Dockerfile.default')
    const content = await fs.readFile(dockerfilePath, 'utf8')
    expect(content).toContain('FROM docker.io/ubuntu:24.04')
    expect(content).toContain('gh')
    expect(content).toContain('tmux')
  })

  it('Dockerfile.tools installs the agent CLIs on top of the base', async () => {
    const dockerfilePath = path.join(DOCKERFILES_DIR, 'Dockerfile.tools')
    const content = await fs.readFile(dockerfilePath, 'utf8')
    expect(content).toMatch(/^ARG BASE_IMAGE\n/m)
    expect(content).toMatch(/^FROM \$\{BASE_IMAGE\}/m)
    expect(content).toContain('claude.ai/install.sh')
    expect(content).toContain('@openai/codex')
    expect(content).toContain('opencode-ai')
  })

  it('Dockerfile.default runs as non-root yaac user', async () => {
    const dockerfilePath = path.join(DOCKERFILES_DIR, 'Dockerfile.default')
    const content = await fs.readFile(dockerfilePath, 'utf8')
    expect(content).toContain('useradd')
    expect(content).toContain('USER yaac')
  })

  it('Dockerfile.default builds yaac with the injected YAAC_UID (idmapped hostPath writes)', async () => {
    const dockerfilePath = path.join(DOCKERFILES_DIR, 'Dockerfile.default')
    const content = await fs.readFile(dockerfilePath, 'utf8')
    expect(content).toMatch(/^ARG YAAC_UID=1000$/m)
    expect(content).toContain('useradd -m -u ${YAAC_UID}')
  })

  it('Dockerfile.default uses catatonit as PID 1 to reap zombies', async () => {
    const dockerfilePath = path.join(DOCKERFILES_DIR, 'Dockerfile.default')
    const content = await fs.readFile(dockerfilePath, 'utf8')
    expect(content).toContain('catatonit')
    expect(content).toMatch(/ENTRYPOINT \[.*"catatonit".*\]/)
    // catatonit runs sleep infinity as PID 2 so the container stays up
    expect(content).toContain('sleep')
    expect(content).toContain('infinity')
  })

})
