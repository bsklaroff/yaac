import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DOCKERFILES_DIR } from '@/shared/project-paths'
import { baseImageHash, contextHash, fileHash, sessionUid, isLayered } from '@/lib/container/image-builder'

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

describe('isLayered', () => {
  it('accepts a Dockerfile that declares ARG BASE_IMAGE and FROM ${BASE_IMAGE}', () => {
    expect(isLayered('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo hi\n')).toBe(true)
  })

  it('rejects a standalone Dockerfile with a concrete FROM', () => {
    expect(isLayered('FROM ubuntu:24.04\nRUN echo hi\n')).toBe(false)
  })

  it('rejects a Dockerfile that declares the arg but pins a concrete base', () => {
    expect(isLayered('ARG BASE_IMAGE\nFROM ubuntu:24.04\n')).toBe(false)
  })
})

describe('sessionUid', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('mirrors the server process uid', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(501)
    expect(sessionUid()).toBe(501)
  })

  it('falls back to 1000 when the server runs as root (uid 0 is taken in the image)', () => {
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

  it('Dockerfile.nestable layers in-pod podman with the docker CLI on the tools image', async () => {
    const dockerfilePath = path.join(DOCKERFILES_DIR, 'Dockerfile.nestable')
    const content = await fs.readFile(dockerfilePath, 'utf8')
    expect(content).toMatch(/^ARG BASE_IMAGE\n/m)
    expect(content).toMatch(/^FROM \$\{BASE_IMAGE\}/m)
    // Engine + build/copy tooling, docker-CLI surface.
    expect(content).toContain('podman')
    expect(content).toContain('skopeo')
    expect(content).toContain('docker-compose')
    // Container-private networks aren't supported in-pod, so no userspace
    // network helper is installed (host netns is the only mode).
    expect(content).not.toContain('default_rootless_network_cmd')
    // The uid the server injects shapes the subuid ranges and socket path.
    expect(content).toMatch(/^ARG YAAC_UID=1000$/m)
    expect(content).toContain('DOCKER_HOST=unix:///run/user/${YAAC_UID}/podman/podman.sock')
    // Everything shares the pod's namespaces — nested egress must stay on
    // the pod-netns redirect (locally-originated traffic).
    expect(content).toContain('netns="host"')
    // Rootless-podman-in-kubernetes settings: the pod userns refuses the
    // per-container keyring and pivot_root.
    expect(content).toContain('keyring=false')
    expect(content).toContain('no_pivot_root=true')
    // Cross-session layer cache rides additionalimagestores.
    expect(content).toContain('additionalimagestores = ["/var/lib/shared-images"]')
    // Nested containers auto-trust the session's MITM CA. Two trust shapes:
    // the ADDITIVE vars point at the bare proxy CA (OpenSSL/Node keep their
    // real roots alongside it); the own-bundle REPLACE vars point at the
    // combined bundle {public roots} ∪ {proxy CA} so curl/requests/cargo/
    // git-libcurl trust both intercepted and tunnelled hosts (see the
    // combined-bundle plan).
    expect(content).toContain('SSL_CERT_FILE=/etc/yaac/certs/proxy-ca.pem')
    expect(content).toContain('NODE_EXTRA_CA_CERTS=/etc/yaac/certs/proxy-ca.pem')
    expect(content).toContain('CURL_CA_BUNDLE=/etc/yaac/certs/ca-bundle.pem')
    expect(content).toContain('REQUESTS_CA_BUNDLE=/etc/yaac/certs/ca-bundle.pem')
    expect(content).toContain('CARGO_HTTP_CAINFO=/etc/yaac/certs/ca-bundle.pem')
    expect(content).toContain('GIT_SSL_CAINFO=/etc/yaac/certs/ca-bundle.pem')
    // The combined bundle is mounted into nested containers (and build RUN
    // steps) alongside the bare CA.
    expect(content).toContain('/etc/yaac/certs/ca-bundle.pem:/etc/yaac/certs/ca-bundle.pem:ro')
    // Build-time trust: the bare proxy CA is dropped into the ca-certificates
    // source dir. Volumes (unlike env) reach `docker build` RUN steps, so
    // `apt-get install ca-certificates` folds it into the image's real roots.
    expect(content).toContain('/etc/yaac/certs/proxy-ca.pem:/usr/local/share/ca-certificates/yaac-proxy-ca.crt:ro')
    // Must NOT bind-mount over the managed bundle file — rename() onto a
    // bind-mountpoint fails EBUSY and breaks `update-ca-certificates`.
    expect(content).not.toContain(':/etc/ssl/certs/ca-certificates.crt:ro')
    // The replace-vars must never point at the bare proxy CA (that breaks
    // tunnelled hosts — the exact regression the combined bundle fixes).
    expect(content).not.toContain('CURL_CA_BUNDLE=/etc/yaac/certs/proxy-ca.pem')
    // newuidmap/newgidmap carry file caps, not setuid.
    expect(content).toContain('setcap cap_setuid+ep /usr/bin/newuidmap')
    expect(content).toContain('setcap cap_setgid+ep /usr/bin/newgidmap')
    // The engine is started by a detached server exec, not an entrypoint
    // override — the image keeps the base catatonit keepalive.
    expect(content).not.toMatch(/^ENTRYPOINT/m)
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
