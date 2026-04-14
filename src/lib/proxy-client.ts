import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { podman } from '@/lib/podman'
import { PROXY_DIR } from '@/lib/paths'
import { contextHash } from '@/lib/image-builder'
import type { InjectionRule } from '@/lib/secret-conventions'

const execFileAsync = promisify(execFile)

export const INTERNAL_PORT = '10255'

export interface ProxyClientConfig {
  image: string
  containerName: string
  hostPort: string
  network: string
  authSecret: string
  requirePrebuilt?: boolean
}

export class ProxyClient {
  private _proxyIp: string | null = null
  private running = false
  private resolvedImage: string | null = null

  constructor(private config: ProxyClientConfig) {}

  get network(): string {
    return this.config.network
  }

  get hostPort(): string {
    return this.config.hostPort
  }

  get proxyIp(): string {
    if (!this._proxyIp) throw new Error('Proxy not started — call ensureRunning() first')
    return this._proxyIp
  }

  private get baseUrl(): string {
    return `http://127.0.0.1:${this.config.hostPort}`
  }

  generateSessionToken(): string {
    return crypto.randomBytes(32).toString('hex')
  }

  getProxyEnv(sessionToken: string): string[] {
    if (!this._proxyIp) throw new Error('Proxy not started — call ensureRunning() first')
    const proxyUrl = `http://x:${sessionToken}@${this._proxyIp}:${INTERNAL_PORT}`
    return [
      `HTTPS_PROXY=${proxyUrl}`,
      `HTTP_PROXY=${proxyUrl}`,
      `https_proxy=${proxyUrl}`,
      `http_proxy=${proxyUrl}`,
      'NODE_EXTRA_CA_CERTS=/tmp/proxy-ca.pem',
      'SSL_CERT_FILE=/tmp/proxy-ca.pem',
      'GIT_SSL_CAINFO=/tmp/proxy-ca.pem',
      'NODE_USE_ENV_PROXY=1',
      'GIT_TERMINAL_PROMPT=0',
      'GIT_HTTP_PROXY_AUTHMETHOD=basic',
    ]
  }

  async getCaCert(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/ca.pem`)
    if (!res.ok) throw new Error(`Failed to fetch CA cert: ${res.status}`)
    return res.text()
  }

  async updateProjectRules(projectId: string, rules: InjectionRule[]): Promise<void> {
    const res = await fetch(`${this.baseUrl}/projects/${encodeURIComponent(projectId)}/rules`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.authSecret}`,
      },
      body: JSON.stringify({ rules }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to update project rules: ${res.status} ${text}`)
    }
  }

  async removeProjectRules(projectId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/projects/${encodeURIComponent(projectId)}/rules`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.config.authSecret}` },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to remove project rules: ${res.status} ${text}`)
    }
  }

  async registerSession(token: string, projectId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.authSecret}`,
      },
      body: JSON.stringify({ token, projectId }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to register session: ${res.status} ${text}`)
    }
  }

  async removeSession(token: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(token)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.config.authSecret}` },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to remove session: ${res.status} ${text}`)
    }
  }

  async ensureRunning(): Promise<void> {
    if (this.running) {
      // Verify still healthy
      try {
        const res = await fetch(`${this.baseUrl}/healthz`)
        if (res.ok) return
      } catch {
        this.running = false
      }
    }
    await this.ensureProxyImage()
    await this.start()
    this.running = true
  }

  private async ensureProxyImage(): Promise<void> {
    const hash = await contextHash(PROXY_DIR)
    const taggedImage = `${this.config.image}:${hash}`
    try {
      await execFileAsync('podman', ['image', 'inspect', taggedImage])
      this.resolvedImage = taggedImage
    } catch {
      if (this.config.requirePrebuilt) {
        throw new Error(
          `Proxy image ${taggedImage} is missing or stale. ` +
          'Restart the test run so the global setup can rebuild it.',
        )
      }
      console.log('Building proxy sidecar image...')
      await new Promise<void>((resolve, reject) => {
        const child = spawn('podman', [
          'build', '-t', taggedImage, PROXY_DIR,
        ], { stdio: 'inherit', timeout: 300_000 })
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
    // Create the internal session network
    try {
      await execFileAsync('podman', ['network', 'create', '--internal', '--disable-dns', this.config.network])
    } catch (err) {
      if (err instanceof Error && err.message.includes('already exists')) { /* ok */ }
      else throw err
    }

    // Remove existing container (force-remove to handle running state)
    try {
      const existing = podman.getContainer(this.config.containerName)
      await existing.remove({ force: true })
    } catch {
      // doesn't exist
    }

    // After force-removing a container, podman's rootlessport process may
    // still hold the host port for a brief moment. Retry create+start to
    // ride out the delay rather than failing immediately.
    let container: Awaited<ReturnType<typeof podman.createContainer>>
    for (let attempt = 0; ; attempt++) {
      try {
        container = await podman.createContainer({
          Image: this.resolvedImage!,
          name: this.config.containerName,
          ExposedPorts: { [`${INTERNAL_PORT}/tcp`]: {} },
          Env: [
            `PORT=${INTERNAL_PORT}`,
            `PROXY_AUTH_SECRET=${this.config.authSecret}`,
          ],
          HostConfig: {
            PortBindings: { [`${INTERNAL_PORT}/tcp`]: [{ HostPort: this.config.hostPort, HostIp: '127.0.0.1' }] },
            NetworkMode: `podman,${this.config.network}`,
          },
        })
        await container.start()
        break
      } catch (err) {
        if (attempt >= 5 || !(err instanceof Error) || !err.message.includes('address already in use')) {
          throw err
        }
        // Clean up the created-but-not-started container before retrying
        try { await podman.getContainer(this.config.containerName).remove({ force: true }) } catch { /* ok */ }
        await new Promise((r) => setTimeout(r, 1000))
      }
    }

    // Resolve proxy IP on internal network
    const info = await container.inspect()
    const networks = info.NetworkSettings.Networks as Record<string, { IPAddress: string }>
    this._proxyIp = networks[this.config.network]?.IPAddress
    if (!this._proxyIp) {
      throw new Error(`Proxy container has no IP on network ${this.config.network}`)
    }

    // Wait for healthcheck
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${this.baseUrl}/healthz`)
        if (res.ok) {
          console.log(`Proxy sidecar running on port ${this.config.hostPort}`)
          return
        }
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error('Proxy sidecar failed to start within 15 seconds')
  }

  async stop(): Promise<void> {
    console.log('Stopping proxy...')
    try {
      const container = podman.getContainer(this.config.containerName)
      await container.stop({ t: 5 })
      await container.remove()
    } catch {
      // already stopped or removed
    }
    try {
      await podman.getNetwork(this.config.network).remove()
    } catch {
      // ok
    }
    this._proxyIp = null
    this.running = false
  }
}

// Default instance
const PROXY_AUTH_SECRET = crypto.randomBytes(32).toString('hex')

export const proxyClient = new ProxyClient({
  image: 'yaac-proxy',
  containerName: 'yaac-proxy',
  hostPort: INTERNAL_PORT,
  network: 'yaac-sessions',
  authSecret: PROXY_AUTH_SECRET,
})
