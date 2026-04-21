import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { SecretProxyRule } from '@/shared/types'
import { podman, ensureNetwork, imageExists } from '@/lib/container/runtime'
import fs from 'node:fs/promises'
import { PROXY_DIR, credentialsDir } from '@/lib/project/paths'
import { contextHash } from '@/lib/container/image-builder'
import { findAvailablePort } from '@/lib/container/port'

// --- Secret convention types & builder (merged from secret-conventions.ts) ---

export interface Injection {
  action: 'set_header' | 'replace_header' | 'remove_header' | 'replace_body_param'
  name: string
  value?: string
}

export interface InjectionRule {
  hostPattern: string
  pathPattern: string
  injections: Injection[]
}

/**
 * Test-only: redirect the post-MITM upstream call for `hostname` to a mock
 * on the proxy's network. Credential injection and TLS termination still
 * run normally; only the final upstream hop is diverted.
 */
export interface UpstreamRedirect {
  host: string
  port: number
  tls?: boolean
}

/**
 * Build proxy injection rules from yaac-config.json's envSecretProxy field.
 * Each entry maps an env var name to a SecretProxyRule that describes how to
 * inject the secret (as a header or body parameter).
 */
export function buildRulesFromConfig(
  envSecretProxy: Record<string, SecretProxyRule>,
  env: Record<string, string | undefined>,
): InjectionRule[] {
  const rules: InjectionRule[] = []

  for (const [envVar, rule] of Object.entries(envSecretProxy)) {
    const value = env[envVar]
    if (!value) {
      console.warn(`Warning: ${envVar} is not set in the environment, skipping proxy rule`)
      continue
    }

    const pathPattern = rule.path ?? '/*'

    let injections: Injection[]
    if (rule.bodyParam) {
      injections = [{ action: 'replace_body_param', name: rule.bodyParam, value }]
    } else {
      const headerName = rule.header ?? 'authorization'
      const prefix = rule.prefix ?? (rule.header ? '' : 'Bearer ')
      const headerValue = `${prefix}${value}`
      injections = [{ action: 'set_header', name: headerName, value: headerValue }]
    }

    for (const host of rule.hosts) {
      rules.push({ hostPattern: host, pathPattern, injections })
    }
  }

  return rules
}

// --- ProxyClient ---

/** Port the proxy server listens on inside its container (fixed). */
export const PROXY_CONTAINER_PORT = '10255'

export interface ProxyClientConfig {
  image: string
  network: string
  requirePrebuilt?: boolean
}

/**
 * Resolved state after ensureRunning() — always has concrete values
 * for container name, host port, and auth secret.
 */
interface ResolvedState {
  containerName: string
  hostPort: string
  authSecret: string
}

export class ProxyClient {
  private _proxyIp: string | null = null
  private running = false
  private resolvedImage: string | null = null
  private resolved: ResolvedState | null = null

  constructor(private config: ProxyClientConfig) {}

  get network(): string {
    return this.config.network
  }

  get hostPort(): string {
    return this.requireResolved().hostPort
  }

  get containerName(): string {
    return this.requireResolved().containerName
  }

  get proxyIp(): string {
    if (!this._proxyIp) throw new Error('Proxy not started — call ensureRunning() first')
    return this._proxyIp
  }

  private get baseUrl(): string {
    return `http://127.0.0.1:${this.requireResolved().hostPort}`
  }

  private get authSecret(): string {
    return this.requireResolved().authSecret
  }

  private requireResolved(): ResolvedState {
    if (!this.resolved) throw new Error('Proxy not started — call ensureRunning() first')
    return this.resolved
  }

  getProxyEnv(sessionId: string): string[] {
    if (!this._proxyIp) throw new Error('Proxy not started — call ensureRunning() first')
    const proxyUrl = `http://x:${sessionId}@${this._proxyIp}:${PROXY_CONTAINER_PORT}`
    return [
      `HTTPS_PROXY=${proxyUrl}`,
      `HTTP_PROXY=${proxyUrl}`,
      `https_proxy=${proxyUrl}`,
      `http_proxy=${proxyUrl}`,
      'NODE_EXTRA_CA_CERTS=/tmp/proxy-ca.pem',
      'SSL_CERT_FILE=/tmp/proxy-ca.pem',
      'GIT_SSL_CAINFO=/tmp/proxy-ca.pem',
      'NO_PROXY=localhost,127.0.0.1,::1',
      'no_proxy=localhost,127.0.0.1,::1',
      'NODE_USE_ENV_PROXY=1',
      'NODE_OPTIONS=--disable-warning=UNDICI-EHPA',
      'GIT_TERMINAL_PROMPT=0',
      'GIT_HTTP_PROXY_AUTHMETHOD=basic',
    ]
  }

  async getCaCert(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/ca.pem`)
    if (!res.ok) throw new Error(`Failed to fetch CA cert: ${res.status}`)
    return res.text()
  }

  async registerSession(
    sessionId: string,
    state: {
      rules: InjectionRule[]
      allowedHosts: string[]
      repoUrl?: string
      tool?: 'claude' | 'codex'
      upstreamRedirects?: Record<string, UpstreamRedirect>
    },
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authSecret}`,
      },
      body: JSON.stringify({
        rules: state.rules,
        allowedHosts: state.allowedHosts,
        repoUrl: state.repoUrl,
        tool: state.tool,
        upstreamRedirects: state.upstreamRedirects,
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to register session: ${res.status} ${text}`)
    }
  }

  async removeSession(sessionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.authSecret}` },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to remove session: ${res.status} ${text}`)
    }
  }

  /**
   * Attach to an already-running proxy sidecar for this image hash without
   * starting a new one. Returns true if the sidecar was found and the
   * instance is ready to issue requests, false otherwise. Used by cleanup
   * paths that want to talk to the proxy only if it already exists.
   */
  async attachIfRunning(): Promise<boolean> {
    if (this.running && this.resolved) {
      try {
        const res = await fetch(`${this.baseUrl}/healthz`)
        if (res.ok) return true
      } catch {
        this.running = false
      }
    }
    const hash = await contextHash(PROXY_DIR)
    const existing = await this.discoverExistingProxy(hash)
    if (!existing) return false
    this.resolved = {
      containerName: existing.containerName,
      hostPort: existing.hostPort,
      authSecret: existing.authSecret,
    }
    this._proxyIp = existing.proxyIp
    this.resolvedImage = `${this.config.image}:${hash}`
    this.running = true
    return true
  }

  async getBlockedHosts(): Promise<Record<string, string[]>> {
    const res = await fetch(`${this.baseUrl}/blocked-hosts`, {
      headers: { 'Authorization': `Bearer ${this.authSecret}` },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to get blocked hosts: ${res.status} ${text}`)
    }
    return res.json() as Promise<Record<string, string[]>>
  }

  async ensureRunning(): Promise<void> {
    // Fast path: already verified in this process
    if (this.running) {
      try {
        const res = await fetch(`${this.baseUrl}/healthz`)
        if (res.ok) return
      } catch {
        this.running = false
      }
    }

    const hash = await contextHash(PROXY_DIR)
    const taggedImage = `${this.config.image}:${hash}`

    // Try to reuse an existing proxy container for this image hash
    const existing = await this.discoverExistingProxy(hash)
    if (existing) {
      this.resolved = {
        containerName: existing.containerName,
        hostPort: existing.hostPort,
        authSecret: existing.authSecret,
      }
      this._proxyIp = existing.proxyIp
      this.resolvedImage = taggedImage
      this.running = true
      this.gcStaleProxies(hash).catch(() => {})
      this.gcStaleTestContainers()
        .then(() => this.gcStaleNetworks())
        .catch(() => {})
      return
    }

    // No reusable proxy — build image if needed and start a new one
    await this.ensureProxyImage(taggedImage)
    await this.start(hash)
    this.running = true
    this.gcStaleProxies(hash).catch(() => {})
  }

  private async discoverExistingProxy(hash: string): Promise<{
    containerName: string
    hostPort: string
    authSecret: string
    proxyIp: string
  } | null> {
    let containers
    try {
      containers = await podman.listContainers({
        all: true,
        filters: { label: ['yaac.proxy=true'] },
      })
    } catch {
      return null
    }

    for (const c of containers) {
      if (c.Labels?.['yaac.proxy.image-hash'] !== hash) continue
      if (c.State !== 'running') continue

      try {
        const name = c.Names?.[0]?.replace(/^\//, '') ?? c.Id
        const info = await podman.getContainer(name).inspect()

        // Recover host port from port bindings
        const ports = info.NetworkSettings?.Ports as
          Record<string, Array<{ HostPort: string }>> | undefined
        const bindings = ports?.[`${PROXY_CONTAINER_PORT}/tcp`]
        const hostPort = bindings?.[0]?.HostPort
        if (!hostPort) continue

        // Recover auth secret from container env
        const envArr: string[] = info.Config?.Env ?? []
        const secretEntry = envArr.find((e) => e.startsWith('PROXY_AUTH_SECRET='))
        if (!secretEntry) continue
        const authSecret = secretEntry.slice('PROXY_AUTH_SECRET='.length)
        if (!authSecret) continue

        // Recover proxy IP on session network
        const networks = info.NetworkSettings?.Networks as
          Record<string, { IPAddress: string }> | undefined
        const proxyIp = networks?.[this.config.network]?.IPAddress
        if (!proxyIp) continue

        // Verify health
        const res = await fetch(`http://127.0.0.1:${hostPort}/healthz`)
        if (!res.ok) continue

        return { containerName: name, hostPort, authSecret, proxyIp }
      } catch {
        continue
      }
    }

    return null
  }

  private async ensureProxyImage(taggedImage: string): Promise<void> {
    if (await imageExists(taggedImage)) {
      this.resolvedImage = taggedImage
      return
    }

    if (this.config.requirePrebuilt) {
      throw new Error(
        `Proxy image ${taggedImage} is missing or stale. ` +
        'Restart the test run so the global setup can rebuild it.',
      )
    }
    console.log('Building proxy sidecar image...')
    await new Promise<void>((resolve, reject) => {
      const buildArgs = ['build', '-t', taggedImage]
      const certFile = process.env.SSL_CERT_FILE
      if (certFile && existsSync(certFile)) {
        buildArgs.push('--volume', `${certFile}:${certFile}:ro`)
        buildArgs.push('--build-arg', `SSL_CERT_FILE=${certFile}`)
      }
      buildArgs.push(PROXY_DIR)
      const child = spawn('podman', buildArgs, { stdio: 'inherit', timeout: 300_000 })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`podman build exited with code ${code}`))
      })
      child.on('error', reject)
    })
    this.resolvedImage = taggedImage
  }

  /**
   * Derive a stable container name from the image hash and network name.
   * Including the network ensures isolation between concurrent test runs
   * (each uses a unique network name) while remaining stable across CLI
   * invocations within the same environment.
   */
  private containerNameFor(imageHash: string): string {
    const netHash = crypto.createHash('sha256')
      .update(this.config.network)
      .digest('hex')
      .slice(0, 8)
    return `yaac-proxy-${imageHash.slice(0, 8)}-${netHash}`
  }

  private async start(hash: string): Promise<void> {
    // Create the internal session network
    await ensureNetwork(this.config.network)

    const containerName = this.containerNameFor(hash)
    const authSecret = crypto.randomBytes(32).toString('hex')
    let hostPort = String(await findAvailablePort(10255))

    // Ensure the host-side credentials dir exists so the bind-mount succeeds
    // even before the user has logged in. The entire directory is mounted
    // RW so the proxy can read GitHub / Codex / Claude credentials at
    // request time and write refreshed Claude OAuth bundles back.
    const credsDir = credentialsDir()
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })

    // Remove leftover container with same name (e.g. exited/dead)
    try {
      await podman.getContainer(containerName).remove({ force: true })
    } catch {
      // doesn't exist
    }

    // After force-removing a container, podman's rootlessport process may
    // still hold the host port for a brief moment. Retry create+start to
    // ride out the delay rather than failing immediately.
    // Podman reports port conflicts as either "address already in use" or
    // "proxy already running" (rootlessport variant).
    let container: Awaited<ReturnType<typeof podman.createContainer>>
    for (let attempt = 0; ; attempt++) {
      try {
        container = await podman.createContainer({
          Image: this.resolvedImage!,
          name: containerName,
          Labels: {
            'yaac.proxy': 'true',
            'yaac.proxy.image-hash': hash,
          },
          ExposedPorts: { [`${PROXY_CONTAINER_PORT}/tcp`]: {} },
          Env: [
            `PORT=${PROXY_CONTAINER_PORT}`,
            `PROXY_AUTH_SECRET=${authSecret}`,
          ],
          HostConfig: {
            PortBindings: {
              [`${PROXY_CONTAINER_PORT}/tcp`]: [{ HostPort: hostPort, HostIp: '127.0.0.1' }],
            },
            NetworkMode: `podman,${this.config.network}`,
            Binds: [
              `${credsDir}:/yaac-credentials:Z`,
            ],
          },
        })
        await container.start()
        break
      } catch (err) {
        const msg = err instanceof Error ? err.message : ''
        const isPortConflict = msg.includes('address already in use') || msg.includes('proxy already running')
        if (attempt >= 5 || !isPortConflict) {
          throw err
        }
        // Clean up the created-but-not-started container before retrying
        try { await podman.getContainer(containerName).remove({ force: true }) } catch { /* ok */ }
        // Port may have been grabbed; find a new one
        hostPort = String(await findAvailablePort(Number(hostPort) + 1))
        await new Promise((r) => setTimeout(r, 500))
      }
    }

    this.resolved = { containerName, hostPort, authSecret }

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
          console.log(`Proxy sidecar running on port ${hostPort}`)
          return
        }
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error('Proxy sidecar failed to start within 15 seconds')
  }

  /**
   * Remove proxy containers that are no longer useful:
   *   - image hash differs from `currentHash` (stale build), OR
   *   - container is in `exited` state (orphaned from a prior run — e.g. a
   *     test worker on a one-off network that finished without calling stop)
   * Proxies with sessions still referencing them are always preserved, as are
   * `running`/`created` proxies (which may belong to a concurrent worker).
   */
  private async gcStaleProxies(currentHash: string): Promise<void> {
    const proxies = await podman.listContainers({
      all: true,
      filters: { label: ['yaac.proxy=true'] },
    })

    for (const p of proxies) {
      const hashMatches = p.Labels?.['yaac.proxy.image-hash'] === currentHash
      const isExited = p.State === 'exited'
      if (hashMatches && !isExited) continue

      const proxyName = p.Names?.[0]?.replace(/^\//, '') ?? p.Id

      // Check if any session containers still reference this proxy
      const sessions = await podman.listContainers({
        all: true,
        filters: { label: [`yaac.proxy-container=${proxyName}`] },
      })
      if (sessions.length > 0) continue

      console.log(`Removing stale proxy ${proxyName}...`)
      try {
        await podman.getContainer(proxyName).remove({ force: true })
      } catch {
        // already gone
      }
    }
  }

  /**
   * Remove exited `yaac.test=true` containers older than 1 hour. Tests
   * clean these up in afterEach, but a crashed or killed test run leaks
   * them — and the leftover exited containers pin their per-test network,
   * blocking gcStaleNetworks. The 1-hour grace period avoids racing a
   * long-running test suite.
   */
  private async gcStaleTestContainers(): Promise<void> {
    const cutoff = Math.floor(Date.now() / 1000) - 60 * 60
    const containers = await podman.listContainers({
      all: true,
      filters: { label: ['yaac.test=true'], status: ['exited'] },
    })

    for (const c of containers) {
      if (typeof c.Created !== 'number' || c.Created > cutoff) continue
      const name = c.Names?.[0]?.replace(/^\//, '') ?? c.Id
      console.log(`Removing stale test container ${name}...`)
      try {
        await podman.getContainer(c.Id).remove({ force: true })
      } catch {
        // already gone
      }
    }
  }

  /**
   * Remove yaac-prefixed networks that are older than 1 hour, have no
   * attached containers, and are not the network this ProxyClient manages.
   * The 1-hour grace period avoids racing concurrent test workers that have
   * just created their network but not yet attached a container.
   */
  private async gcStaleNetworks(): Promise<void> {
    const cutoff = Date.now() - 60 * 60 * 1000
    const networks = await podman.listNetworks() as Array<{
      Name?: string
      Created?: string
    }>

    for (const n of networks) {
      if (!n.Name?.startsWith('yaac-')) continue
      if (n.Name === this.config.network) continue

      const created = Date.parse(n.Created ?? '')
      if (!Number.isFinite(created) || created > cutoff) continue

      // The compat /networks endpoint's Containers field only lists *running*
      // containers, but podman refuses to remove a network that still has
      // stopped/exited containers attached. Query for all attached containers
      // directly so we skip silently instead of logging + failing each run.
      const attached = await podman.listContainers({
        all: true,
        filters: { network: [n.Name] },
      })
      if (attached.length > 0) continue

      console.log(`Removing stale network ${n.Name}...`)
      try {
        await podman.getNetwork(n.Name).remove()
      } catch {
        // already gone
      }
    }
  }

  async stop(): Promise<void> {
    console.log('Stopping proxy...')
    if (this.resolved) {
      try {
        await podman.getContainer(this.resolved.containerName).remove({ force: true })
      } catch {
        // already stopped or removed
      }
    }
    try {
      await podman.getNetwork(this.config.network).remove()
    } catch {
      // ok
    }
    this._proxyIp = null
    this.running = false
    this.resolved = null
  }
}

/**
 * Compute the proxy sidecar image tag without starting or building anything.
 * Useful for fingerprinting — the tag encodes the content of podman/proxy-sidecar/.
 */
export async function resolveProxyImageTag(image = 'yaac-proxy'): Promise<string> {
  const hash = await contextHash(PROXY_DIR)
  return `${image}:${hash}`
}

// Default singleton — resolved state is populated by ensureRunning().
// YAAC_PROXY_IMAGE / YAAC_PROXY_NETWORK are test-only hooks that let the
// e2e-cli suite point a daemon subprocess at pre-built test images and an
// isolated sidecar network. Unset in production.
export const proxyClient = new ProxyClient({
  image: process.env.YAAC_PROXY_IMAGE ?? 'yaac-proxy',
  network: process.env.YAAC_PROXY_NETWORK ?? 'yaac-sessions',
  requirePrebuilt: process.env.YAAC_REQUIRE_PREBUILT_IMAGES === '1',
})
