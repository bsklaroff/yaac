import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensurePodmanSocket } from '@/lib/container/runtime'

describe('ensurePodmanSocket', () => {
  let tmpDir: string | null = null
  let server: net.Server | null = null

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()))
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
    server = null
    tmpDir = null
  })

  it('returns immediately when the socket already accepts connections', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ensure-sock-alive-'))
    const socketPath = path.join(tmpDir, 'test.sock')
    server = net.createServer()
    await new Promise<void>((r) => server!.listen(socketPath, r))

    const start = Date.now()
    await ensurePodmanSocket(socketPath, { timeoutMs: 5_000, pollMs: 25 })
    // A revive attempt would spawn podman and take noticeably longer than
    // a fast local connect; 500ms is generous.
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('throws a timeout error when the spawned service never binds', async () => {
    // Point at a socket path inside a non-existent directory so `podman
    // system service` cannot bind (whether or not podman is installed).
    const socketPath = '/nonexistent/definitely/does/not/exist.sock'
    await expect(
      ensurePodmanSocket(socketPath, { timeoutMs: 300, pollMs: 25 }),
    ).rejects.toThrow(/did not become ready/)
  })
})
