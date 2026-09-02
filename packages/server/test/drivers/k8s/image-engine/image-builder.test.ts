import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DOCKERFILES_DIR } from '@yaac/shared/project-paths'
import {
  baseImageHash,
  contextHash,
  fileHash,
  resolveTrustedLayers,
  toolsContentHash,
} from '#drivers/k8s/image-engine/image-builder'
import { podUid } from '#drivers/k8s/substrate'

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

  it('returns different hashes for different content', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-fh-'))
    try {
      const a = path.join(tmpDir, 'a.txt')
      const b = path.join(tmpDir, 'b.txt')
      await fs.writeFile(a, 'content A')
      await fs.writeFile(b, 'content B')
      expect(await fileHash(a)).not.toBe(await fileHash(b))
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('toolsContentHash', () => {
  it('produces a stable 16-char hex hash', async () => {
    const hash = await toolsContentHash()
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    expect(await toolsContentHash()).toBe(hash)
  })

  it('folds the COPY support files in, not just the Dockerfile', async () => {
    const dockerfileOnly = await fileHash(path.join(DOCKERFILES_DIR, 'Dockerfile.tools'))
    expect(await toolsContentHash()).not.toBe(dockerfileOnly)
  })
})

describe('baseImageHash', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('folds the uid it is given and the in-pod daemons into the Dockerfile content hash', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-bih-'))
    try {
      const dockerfile = path.join(tmpDir, 'Dockerfile')
      await fs.writeFile(dockerfile, 'FROM scratch')

      // The uid is the ARGUMENT, never this process's own: a build for a
      // uid other than the builder's is exactly what `yaac cluster install`
      // does, and reading getuid() here would tag those images identically.
      vi.spyOn(process, 'getuid').mockReturnValue(1000)
      const hash501 = await baseImageHash(dockerfile, 501)
      const hash1000 = await baseImageHash(dockerfile, 1000)

      expect(hash501).toMatch(/^[0-9a-f]{16}$/)
      // A uid change must invalidate the tag like a Dockerfile edit would —
      // the pod runs as that uid, so an image baked for another one cannot
      // write the dirs the server pre-created.
      expect(hash501).not.toBe(hash1000)
      // The COPY'd streamd/acpd sources are in there too, so the tag is
      // never just the Dockerfile's own hash.
      expect(hash501).not.toBe(await fileHash(dockerfile))
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('resolveTrustedLayers', () => {
  it('names the three yaac-shipped layers, each built FROM the one above it', async () => {
    const { base, tools, nestable } = await resolveTrustedLayers('yaac')

    // The chain `yaac cluster install` builds, in the only order it can be
    // built in: each layer's parent tag is the previous layer's.
    expect(base.name).toBe('base')
    expect(tools.name).toBe('tools')
    expect(nestable.name).toBe('nestable')
    expect(tools.buildArgs?.BASE_IMAGE).toBe(base.tag)
    expect(nestable.buildArgs?.BASE_IMAGE).toBe(tools.tag)
    // Every one is a real, shipped build context — this is what makes the
    // install's `podman build` and the server's registry lookup agree.
    expect(base.dockerfile).toBe(path.join(DOCKERFILES_DIR, 'Dockerfile.default'))
    expect(tools.dockerfile).toBe(path.join(DOCKERFILES_DIR, 'Dockerfile.tools'))
    expect(nestable.dockerfile).toBe(path.join(DOCKERFILES_DIR, 'Dockerfile.nestable'))
    for (const layer of [base, tools, nestable]) {
      expect(layer.context).toBe(DOCKERFILES_DIR)
      expect(layer.tag).toMatch(/^yaac-(base|tools|nestable):[0-9a-f]{16}$/)
      expect(layer.tag.endsWith(layer.contentHash)).toBe(true)
    }
    // The uid is a build input of the layers that create the `yaac` user.
    expect(base.buildArgs?.YAAC_UID).toBe(String(podUid()))
    expect(nestable.buildArgs?.YAAC_UID).toBe(String(podUid()))
  })

  it('carries the requested uid into the tag, not just into the build arg', async () => {
    // The bug this guards: the base layer's content hash read the CALLING
    // process's uid while the build arg carried `forUid`, so an install
    // building for the server's uid tagged the image with its own — and
    // then found that tag "already in the registry" and reused an image
    // whose `yaac` user was somebody else's number.
    const forServer = await resolveTrustedLayers('yaac', 1000)
    const forOther = await resolveTrustedLayers('yaac', 501)

    expect(forServer.base.buildArgs?.YAAC_UID).toBe('1000')
    expect(forOther.base.buildArgs?.YAAC_UID).toBe('501')
    expect(forServer.base.tag).not.toBe(forOther.base.tag)
    // And it composes down the chain, so tools/nestable cannot be shared
    // across uids either.
    expect(forServer.tools.tag).not.toBe(forOther.tools.tag)
    expect(forServer.nestable.tag).not.toBe(forOther.nestable.tag)
  })

  it('scopes every tag to the prefix, so a test run never collides with the install', async () => {
    const yaac = await resolveTrustedLayers('yaac')
    const test = await resolveTrustedLayers('yaac-test')

    expect(test.base.tag.startsWith('yaac-test-base:')).toBe(true)
    expect(test.tools.tag.startsWith('yaac-test-tools:')).toBe(true)
    expect(test.nestable.tag.startsWith('yaac-test-nestable:')).toBe(true)
    // Same content, so the hashes match — only the repository differs.
    expect(test.base.contentHash).toBe(yaac.base.contentHash)
    expect(test.tools.buildArgs?.BASE_IMAGE).toBe(test.base.tag)
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

  it('skips paths listed in .containerignore', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ctx-'))
    try {
      await fs.writeFile(path.join(tmpDir, '.containerignore'), 'node_modules\ntest\n')
      await fs.writeFile(path.join(tmpDir, 'a.txt'), 'hello')
      const hash1 = await contextHash(tmpDir)

      await fs.mkdir(path.join(tmpDir, 'node_modules'))
      await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg.txt'), 'noise')
      await fs.mkdir(path.join(tmpDir, 'test'))
      await fs.writeFile(path.join(tmpDir, 'test', 'a.test.ts'), 'noise')
      const hash2 = await contextHash(tmpDir)

      expect(hash2).toBe(hash1)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('hashes .containerignore itself, so pattern edits change the tag', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ctx-'))
    try {
      await fs.writeFile(path.join(tmpDir, 'a.txt'), 'hello')
      await fs.writeFile(path.join(tmpDir, '.containerignore'), 'node_modules\n')
      const hash1 = await contextHash(tmpDir)

      await fs.writeFile(path.join(tmpDir, '.containerignore'), 'node_modules\ntest\n')
      const hash2 = await contextHash(tmpDir)

      expect(hash2).not.toBe(hash1)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('hashes everything when there is no .containerignore (matching podman)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ctx-'))
    try {
      await fs.writeFile(path.join(tmpDir, 'a.txt'), 'hello')
      const hash1 = await contextHash(tmpDir)

      await fs.mkdir(path.join(tmpDir, 'node_modules'))
      await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg.txt'), 'noise')
      const hash2 = await contextHash(tmpDir)

      expect(hash2).not.toBe(hash1)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('reads comments, blank lines, trailing slashes, and nested paths in .containerignore', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ctx-'))
    try {
      await fs.writeFile(path.join(tmpDir, '.containerignore'),
        '# dev artifacts\nnode_modules/\n\ntest\na/b.txt\n')
      await fs.writeFile(path.join(tmpDir, 'keep.txt'), 'hello')
      await fs.mkdir(path.join(tmpDir, 'a'))
      const hash1 = await contextHash(tmpDir)

      // Every listed form — trailing-slash dir, plain dir, nested file — is
      // excluded; the comment and blank line are not patterns.
      await fs.mkdir(path.join(tmpDir, 'node_modules'))
      await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg.txt'), 'noise')
      await fs.mkdir(path.join(tmpDir, 'test'))
      await fs.writeFile(path.join(tmpDir, 'test', 'a.test.ts'), 'noise')
      await fs.writeFile(path.join(tmpDir, 'a', 'b.txt'), 'noise')
      expect(await contextHash(tmpDir)).toBe(hash1)

      // An unlisted sibling of an excluded path still counts.
      await fs.writeFile(path.join(tmpDir, 'a', 'c.txt'), 'real')
      expect(await contextHash(tmpDir)).not.toBe(hash1)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('rejects glob and negation patterns instead of silently mismatching podman', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ctx-'))
    try {
      for (const pattern of ['*.log', 'test?', '[ab]', '!keep', '/anchored']) {
        await fs.writeFile(path.join(tmpDir, '.containerignore'), pattern)
        await expect(contextHash(tmpDir)).rejects.toThrow(/unsupported .containerignore pattern/)
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("the proxy context's .containerignore keeps unit tests out of the image hash", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ctx-'))
    try {
      // The real shipped exclusions, applied to a stand-in context: adding
      // node_modules and co-located tests must not churn the image tag.
      await fs.cp(path.join(DOCKERFILES_DIR, '..', 'k8s', 'proxy', '.containerignore'),
        path.join(tmpDir, '.containerignore'))
      await fs.writeFile(path.join(tmpDir, 'index.ts'), 'export {}')
      const hash1 = await contextHash(tmpDir)

      await fs.mkdir(path.join(tmpDir, 'node_modules'))
      await fs.writeFile(path.join(tmpDir, 'node_modules', 'dep.js'), 'noise')
      await fs.mkdir(path.join(tmpDir, 'test'))
      await fs.writeFile(path.join(tmpDir, 'test', 'proxy.test.ts'), 'noise')
      expect(await contextHash(tmpDir)).toBe(hash1)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})
