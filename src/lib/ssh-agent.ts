import os from 'node:os'
import path from 'node:path'
import { readdirSync, existsSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { podman } from '@/lib/podman'
import { SSH_AGENT_DIR } from '@/lib/paths'

const execFileAsync = promisify(execFile)

const VOLUME_NAME = 'yaac-ssh-agent'
const CONTAINER_NAME = 'yaac-ssh-agent'
const IMAGE_NAME = 'yaac-ssh-agent'

export function hasSshKeys(sshDir?: string): boolean {
  const dir = sshDir ?? path.join(os.homedir(), '.ssh')
  if (!existsSync(dir)) return false
  try {
    const files = readdirSync(dir)
    return files.some(f => f.startsWith('id_') && !f.endsWith('.pub'))
  } catch {
    return false
  }
}

export class SshAgentClient {
  private running = false
  private sshDir: string

  constructor(sshDir?: string) {
    this.sshDir = sshDir ?? path.join(os.homedir(), '.ssh')
  }

  getSshEnv(): string[] {
    return ['SSH_AUTH_SOCK=/ssh-agent/socket']
  }

  getBinds(): string[] {
    return [`${VOLUME_NAME}:/ssh-agent`]
  }

  async ensureRunning(): Promise<void> {
    if (this.running) {
      try {
        const info = await podman.getContainer(CONTAINER_NAME).inspect()
        if (info.State.Running) return
      } catch {
        this.running = false
      }
    }

    await this.ensureImage()
    await this.start()
    this.running = true
  }

  private async ensureImage(): Promise<void> {
    try {
      await execFileAsync('podman', ['image', 'inspect', IMAGE_NAME])
    } catch {
      console.log('Building SSH agent sidecar image...')
      await new Promise<void>((resolve, reject) => {
        const child = spawn('podman', [
          'build', '-t', IMAGE_NAME, SSH_AGENT_DIR,
        ], { stdio: 'inherit', timeout: 120_000 })
        child.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`podman build exited with code ${code}`))
        })
        child.on('error', reject)
      })
    }
  }

  private async start(): Promise<void> {
    // Create shared volume for the agent socket
    try {
      await execFileAsync('podman', ['volume', 'create', VOLUME_NAME])
    } catch (err) {
      if (err instanceof Error && err.message.includes('already exists')) { /* ok */ }
      else throw err
    }

    // Remove existing container
    try {
      const existing = podman.getContainer(CONTAINER_NAME)
      await existing.remove({ force: true })
    } catch {
      // doesn't exist
    }

    const container = await podman.createContainer({
      Image: IMAGE_NAME,
      name: CONTAINER_NAME,
      Labels: { 'yaac.managed': 'true' },
      HostConfig: {
        Binds: [
          `${this.sshDir}:/ssh-keys:ro,Z`,
          `${VOLUME_NAME}:/ssh-agent`,
        ],
      },
    })

    await container.start()

    // Wait for agent to be ready (socket file created)
    for (let i = 0; i < 20; i++) {
      try {
        const { stdout } = await execFileAsync('podman', [
          'exec', CONTAINER_NAME, 'ssh-add', '-l',
        ], { env: { ...process.env, SSH_AUTH_SOCK: '/ssh-agent/socket' } })
        console.log(`SSH agent ready: ${stdout.trim()}`)
        return
      } catch {
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    console.warn('Warning: SSH agent started but no keys could be verified')
  }

  async stop(): Promise<void> {
    try {
      const container = podman.getContainer(CONTAINER_NAME)
      await container.stop({ t: 2 })
      await container.remove()
    } catch {
      // already stopped or removed
    }
    try {
      await execFileAsync('podman', ['volume', 'rm', VOLUME_NAME])
    } catch {
      // ok
    }
    this.running = false
  }
}

export const sshAgent = new SshAgentClient()
