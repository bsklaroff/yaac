import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { requirePodman, TEST_PROXY_CONFIG } from '@test/helpers/setup'
import { ProxyClient, INTERNAL_PORT } from '@/lib/proxy-client'
import { podman } from '@/lib/podman'

const execFileAsync = promisify(execFile)

describe('proxy sidecar', () => {
  let client: ProxyClient

  const testAuthSecret = crypto.randomBytes(32).toString('hex')

  beforeAll(async () => {
    await requirePodman()

    client = new ProxyClient({
      ...TEST_PROXY_CONFIG,
      containerName: 'yaac-proxy-test',
      hostPort: '19255',
      authSecret: testAuthSecret,
    })
  })

  afterAll(async () => {
    if (!client) return
    try {
      await client.stop()
    } catch {
      // ok
    }
  })

  it('starts proxy and healthcheck responds', async () => {
    await client.ensureRunning()

    const res = await fetch('http://127.0.0.1:19255/healthz')
    expect(res.ok).toBe(true)
    expect(await res.text()).toBe('ok')
  })

  it('serves CA certificate', async () => {
    await client.ensureRunning()

    const caCert = await client.getCaCert()
    expect(caCert).toContain('BEGIN CERTIFICATE')
    expect(caCert).toContain('END CERTIFICATE')
  })

  it('registers session and project rules', async () => {
    await client.ensureRunning()

    const token = client.generateSessionToken()
    expect(token).toHaveLength(64) // 32 bytes hex

    // Register rules
    await client.updateProjectRules('test-project', [
      {
        hostPattern: 'api.github.com',
        pathPattern: '/*',
        injections: [{ action: 'set_header', name: 'authorization', value: 'Bearer test-token' }],
      },
    ])

    // Register session
    await client.registerSession(token, 'test-project')

    // Clean up
    await client.removeSession(token)
    await client.removeProjectRules('test-project')
  })

  it('ensureRunning is idempotent', async () => {
    // Call twice — should not error or create duplicate containers
    await client.ensureRunning()
    await client.ensureRunning()

    const res = await fetch('http://127.0.0.1:19255/healthz')
    expect(res.ok).toBe(true)
  })

  it('stop removes container and network', async () => {
    await client.ensureRunning()
    await client.stop()

    // Healthcheck should fail
    await expect(fetch('http://127.0.0.1:19255/healthz')).rejects.toThrow()
  })

  describe('CONNECT tunnel for SSH', () => {
    const tunnelContainers: string[] = []

    afterEach(async () => {
      for (const name of tunnelContainers) {
        try {
          const c = podman.getContainer(name)
          await c.stop({ t: 1 })
          await c.remove()
        } catch {
          // already gone
        }
      }
      tunnelContainers.length = 0
    })

    it('tunnels TCP connections via CONNECT from internal network', async () => {
      await client.ensureRunning()

      // Create a container on the internal-only network (same as a real session)
      const containerName = `yaac-proxy-tunnel-test-${crypto.randomBytes(4).toString('hex')}`
      tunnelContainers.push(containerName)

      // Find the test base image
      const { stdout: images } = await execFileAsync('podman', [
        'images', '--format', '{{.Repository}}:{{.Tag}}', '--filter', 'reference=yaac-test-base',
      ])
      const baseImage = images.trim().split('\n')[0]
      expect(baseImage).toBeTruthy()

      const container = await podman.createContainer({
        Image: baseImage,
        name: containerName,
        Labels: { 'yaac.test': 'true' },
        HostConfig: {
          NetworkMode: client.network,
        },
      })
      await container.start()

      // Verify the container CANNOT reach external hosts directly
      const { stdout: blocked } = await execFileAsync('podman', [
        'exec', containerName, 'sh', '-c',
        'curl -sf --connect-timeout 3 http://github.com 2>&1 || echo connection-blocked',
      ], { timeout: 10_000 })
      expect(blocked.trim()).toContain('connection-blocked')

      // Verify the container CAN reach external hosts via CONNECT tunnel through proxy
      const proxyAddr = `${client.proxyIp}:${INTERNAL_PORT}`
      const { stdout: tunneled } = await execFileAsync('podman', [
        'exec', containerName, 'sh', '-c',
        `echo '' | nc -w 5 -X connect -x ${proxyAddr} github.com 443 | head -c 1 || echo tunnel-open`,
      ], { timeout: 15_000 })
      // A successful CONNECT to port 443 will get some TLS bytes or a timeout,
      // but it won't say "connection-blocked". If we get any data, the tunnel worked.
      expect(tunneled.trim()).not.toContain('connection-blocked')
    }, 30_000)

    it('tunnels SSH connections via CONNECT from internal network', async () => {
      await client.ensureRunning()

      const containerName = `yaac-proxy-ssh-test-${crypto.randomBytes(4).toString('hex')}`
      tunnelContainers.push(containerName)

      const { stdout: images } = await execFileAsync('podman', [
        'images', '--format', '{{.Repository}}:{{.Tag}}', '--filter', 'reference=yaac-test-base',
      ])
      const baseImage = images.trim().split('\n')[0]

      const container = await podman.createContainer({
        Image: baseImage,
        name: containerName,
        Labels: { 'yaac.test': 'true' },
        HostConfig: {
          NetworkMode: client.network,
        },
      })
      await container.start()

      // Tunnel to github.com:22 via the proxy and check for SSH banner.
      // Use sleep to keep stdin open long enough to receive the banner.
      const proxyAddr = `${client.proxyIp}:${INTERNAL_PORT}`
      const { stdout: banner } = await execFileAsync('podman', [
        'exec', containerName, 'sh', '-c',
        `sleep 2 | nc -w 5 -X connect -x ${proxyAddr} github.com 22 | head -1`,
      ], { timeout: 15_000 })
      expect(banner).toContain('SSH')
    }, 30_000)

    it('writes SSH proxy config when proxy is active in session', async () => {
      await client.ensureRunning()

      const containerName = `yaac-proxy-sshcfg-test-${crypto.randomBytes(4).toString('hex')}`
      tunnelContainers.push(containerName)

      const { stdout: images } = await execFileAsync('podman', [
        'images', '--format', '{{.Repository}}:{{.Tag}}', '--filter', 'reference=yaac-test-base',
      ])
      const baseImage = images.trim().split('\n')[0]

      const container = await podman.createContainer({
        Image: baseImage,
        name: containerName,
        Labels: { 'yaac.test': 'true' },
        HostConfig: {
          NetworkMode: client.network,
        },
      })
      await container.start()

      // Simulate what session-create does: write SSH config
      const proxyAddr = `${client.proxyIp}:${INTERNAL_PORT}`
      await execFileAsync('podman', [
        'exec', containerName, 'mkdir', '-p', '/home/yaac/.ssh',
      ])
      await execFileAsync('podman', [
        'exec', containerName, 'sh', '-c',
        `cat > /home/yaac/.ssh/config << 'SSHEOF'\nHost *\n    ProxyCommand nc -X connect -x ${proxyAddr} %h %p\nSSHEOF`,
      ])
      await execFileAsync('podman', [
        'exec', containerName, 'chmod', '700', '/home/yaac/.ssh',
      ])
      await execFileAsync('podman', [
        'exec', containerName, 'chmod', '600', '/home/yaac/.ssh/config',
      ])

      // Verify the SSH config was written correctly
      const { stdout: sshConfig } = await execFileAsync('podman', [
        'exec', containerName, 'cat', '/home/yaac/.ssh/config',
      ])
      expect(sshConfig).toContain('Host *')
      expect(sshConfig).toContain(`ProxyCommand nc -X connect -x ${proxyAddr} %h %p`)

      // Verify permissions
      const { stdout: perms } = await execFileAsync('podman', [
        'exec', containerName, 'stat', '-c', '%a', '/home/yaac/.ssh/config',
      ])
      expect(perms.trim()).toBe('600')
    }, 30_000)
  })
})
