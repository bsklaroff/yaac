import { podman, ensureNetwork, imageExists, execFileAsync } from '@/lib/container/runtime'
import type { PostgresRelayConfig } from '@/shared/types'

const SOCAT_IMAGE = 'docker.io/alpine/socat:1.8.0.3'
const DEFAULT_HOST_PORT = 5432
const DEFAULT_CONTAINER_PORT = 5432

export const PG_RELAY_CONTAINER = 'yaac-pg-relay'
export const SESSION_NETWORK = 'yaac-sessions'

export interface PgRelayClientConfig {
  containerName?: string
  network?: string
}

export class PgRelayClient {
  private running = false
  private _ip: string | null = null
  private _containerPort: number = DEFAULT_CONTAINER_PORT
  private _containerName: string
  private _network: string

  constructor(config?: PgRelayClientConfig) {
    this._containerName = config?.containerName ?? PG_RELAY_CONTAINER
    this._network = config?.network ?? SESSION_NETWORK
  }

  get ip(): string {
    if (!this._ip) throw new Error('PG relay not started — call ensureRunning() first')
    return this._ip
  }

  get containerPort(): number {
    return this._containerPort
  }

  async ensureRunning(config?: PostgresRelayConfig): Promise<void> {
    this._containerPort = config?.containerPort ?? DEFAULT_CONTAINER_PORT

    try {
      const info = await podman.getContainer(this._containerName).inspect()
      if (info.State.Running) {
        const networks = info.NetworkSettings.Networks as Record<string, { IPAddress: string }>
        this._ip = networks[this._network]?.IPAddress ?? null
        if (this._ip) {
          this.running = true
          return
        }
      }
    } catch {
      // container doesn't exist
    }

    await this.start(config)
    this.running = true
  }

  private async start(config?: PostgresRelayConfig): Promise<void> {
    const hostPort = config?.hostPort ?? DEFAULT_HOST_PORT
    const containerPort = config?.containerPort ?? DEFAULT_CONTAINER_PORT

    // Ensure the session network exists
    await ensureNetwork(this._network)

    // Pull socat image if needed
    if (!await imageExists(SOCAT_IMAGE)) {
      console.log('Pulling socat image...')
      await execFileAsync('podman', ['pull', SOCAT_IMAGE], { timeout: 120_000 })
    }

    // Remove existing container
    try {
      const existing = podman.getContainer(this._containerName)
      await existing.remove({ force: true })
    } catch {
      // doesn't exist
    }

    const container = await podman.createContainer({
      Image: SOCAT_IMAGE,
      name: this._containerName,
      Cmd: [
        `TCP-LISTEN:${containerPort},fork,reuseaddr`,
        `TCP:host.containers.internal:${hostPort}`,
      ],
      HostConfig: {
        NetworkMode: `podman,${this._network}`,
      },
    })
    await container.start()

    // Resolve IP on the session network
    const info = await container.inspect()
    const networks = info.NetworkSettings.Networks as Record<string, { IPAddress: string }>
    this._ip = networks[this._network]?.IPAddress
    if (!this._ip) {
      throw new Error(`PG relay container has no IP on network ${this._network}`)
    }

    // Wait for socat to start listening
    for (let i = 0; i < 10; i++) {
      try {
        await execFileAsync('podman', [
          'exec', this._containerName, 'sh', '-c', `nc -z 127.0.0.1 ${containerPort}`,
        ])
        console.log(`PostgreSQL relay running (localhost:${containerPort} -> host:${hostPort})`)
        return
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    // socat starts fast; warn but don't fail
    console.warn('Warning: PG relay started but port check did not succeed')
  }

  async stop(): Promise<void> {
    try {
      await podman.getContainer(this._containerName).remove({ force: true })
    } catch {
      // already stopped or removed
    }
    this._ip = null
    this.running = false
  }
}

export const pgRelay = new PgRelayClient()
