import os from 'node:os'
import path from 'node:path'
import { readdirSync, existsSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { podman } from '@/lib/podman'
import { SSH_AGENT_DIR } from '@/lib/paths'
import { contextHash } from '@/lib/image-builder'

const execFileAsync = promisify(execFile)

export interface SshAgentConfig {
  containerName: string
  volumeName: string
  imageName: string
  requirePrebuilt?: boolean
}

const DEFAULT_CONFIG: SshAgentConfig = {
  containerName: 'yaac-ssh-agent',
  volumeName: 'yaac-ssh-agent',
  imageName: 'yaac-ssh-agent',
}

export function hasSshKeys(sshDir?: string): boolean {
  const dir = sshDir ?? path.join(os.homedir(), '.ssh')
  if (!existsSync(dir)) return false
  try {
    const files = readdirSync(dir)
    return files.some((f) => f.startsWith('id_') && !f.endsWith('.pub'))
  } catch {
    return false
  }
}

export class SshAgentClient {
  private running = false
  private sshDir: string
  private config: SshAgentConfig
  private resolvedImage: string | null = null

  constructor(sshDir?: string, config?: SshAgentConfig) {
    this.sshDir = sshDir ?? path.join(os.homedir(), '.ssh')
    this.config = config ?? DEFAULT_CONFIG
  }

  getSshEnv(): string[] {
    return ['SSH_AUTH_SOCK=/ssh-agent/socket']
  }

  getBinds(): string[] {
    return [`${this.config.volumeName}:/ssh-agent`]
  }

  async ensureRunning(): Promise<void> {
    try {
      const info = await podman.getContainer(this.config.containerName).inspect()
      if (info.State.Running) {
        this.running = true
        return
      }
    } catch {
      // container doesn't exist
    }

    await this.ensureImage()
    await this.start()
    this.running = true
  }

  private async ensureImage(): Promise<void> {
    const hash = await contextHash(SSH_AGENT_DIR)
    const taggedImage = `${this.config.imageName}:${hash}`
    try {
      await execFileAsync('podman', ['image', 'inspect', taggedImage])
      this.resolvedImage = taggedImage
    } catch {
      if (this.config.requirePrebuilt) {
        throw new Error(
          `SSH agent image ${taggedImage} is missing or stale. ` +
          'Restart the test run so the global setup can rebuild it.',
        )
      }
      console.log('Building SSH agent sidecar image...')
      await new Promise<void>((resolve, reject) => {
        const child = spawn('podman', [
          'build', '-t', taggedImage, SSH_AGENT_DIR,
        ], { stdio: 'inherit', timeout: 120_000 })
        child.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`podman build exited with code ${code}`))
        })
        child.on('error', reject)
      })
      this.resolvedImage = taggedImage
    }
  }

  private async start(): Promise<void> {
    // Create shared volume for the agent socket
    try {
      await execFileAsync('podman', ['volume', 'create', this.config.volumeName])
    } catch (err) {
      if (err instanceof Error && err.message.includes('already exists')) { /* ok */ }
      else throw err
    }

    // Remove existing container
    try {
      const existing = podman.getContainer(this.config.containerName)
      await existing.remove({ force: true })
    } catch {
      // doesn't exist
    }

    const container = await podman.createContainer({
      Image: this.resolvedImage!,
      name: this.config.containerName,
      Labels: {},
      HostConfig: {
        Binds: [
          `${this.sshDir}:/ssh-keys:ro,Z`,
          `${this.config.volumeName}:/ssh-agent`,
        ],
      },
    })

    await container.start()

    // Wait for agent to be ready (socket file created)
    for (let i = 0; i < 20; i++) {
      try {
        const { stdout } = await execFileAsync('podman', [
          'exec', '-e', 'SSH_AUTH_SOCK=/ssh-agent/socket',
          this.config.containerName, 'ssh-add', '-l',
        ])
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
      const container = podman.getContainer(this.config.containerName)
      await container.stop({ t: 2 })
      await container.remove()
    } catch {
      // already stopped or removed
    }
    try {
      await execFileAsync('podman', ['volume', 'rm', this.config.volumeName])
    } catch {
      // ok
    }
    this.running = false
  }
}

export const sshAgent = new SshAgentClient()
