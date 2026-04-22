import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import net from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensurePodmanSocket } from '@/lib/container/runtime'
import { requirePodman } from '@test/helpers/setup'

const execFileAsync = promisify(execFile)

async function socketAccepts(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath)
    sock.once('connect', () => { sock.end(); resolve(true) })
    sock.once('error', () => resolve(false))
  })
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

async function pidsForSocket(socketPath: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', `unix://${socketPath}`])
    return stdout.trim().split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

async function killServicesOn(socketPath: string): Promise<void> {
  for (const pid of await pidsForSocket(socketPath)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

function spawnService(socketPath: string): ReturnType<typeof spawn> {
  const child = spawn(
    'podman',
    ['system', 'service', '--time=0', `unix://${socketPath}`],
    { detached: true, stdio: 'ignore' },
  )
  child.on('error', () => { /* propagates via waitFor timeout below */ })
  child.unref()
  return child
}

describe('ensurePodmanSocket revives a dead podman service (real podman)', () => {
  let tmpDir: string
  let socketPath: string

  beforeEach(async () => {
    await requirePodman()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-revive-'))
    socketPath = path.join(tmpDir, 'podman.sock')
  })

  afterEach(async () => {
    await killServicesOn(socketPath)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('spawns a new podman system service when the socket is dead', async () => {
    const initial = spawnService(socketPath)
    expect(await waitFor(() => socketAccepts(socketPath), 10_000)).toBe(true)

    process.kill(initial.pid!, 'SIGKILL')
    expect(await waitFor(async () => !(await socketAccepts(socketPath)), 5_000)).toBe(true)

    await ensurePodmanSocket(socketPath, { timeoutMs: 10_000 })
    expect(await socketAccepts(socketPath)).toBe(true)
  })

  it('does not spawn a second service when the socket is already alive', async () => {
    const initial = spawnService(socketPath)
    expect(await waitFor(() => socketAccepts(socketPath), 10_000)).toBe(true)

    const before = (await pidsForSocket(socketPath)).length
    await ensurePodmanSocket(socketPath, { timeoutMs: 5_000 })
    const after = (await pidsForSocket(socketPath)).length

    expect(after).toBe(before)
    expect(() => process.kill(initial.pid!, 0)).not.toThrow()
    expect(await socketAccepts(socketPath)).toBe(true)
  })
})
