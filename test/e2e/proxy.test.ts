import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import { requirePodman } from '@test/helpers/setup'
import { ProxyClient } from '@/lib/proxy-client'

describe('proxy sidecar', () => {
  let client: ProxyClient

  const testAuthSecret = crypto.randomBytes(32).toString('hex')

  beforeAll(async () => {
    await requirePodman()

    client = new ProxyClient({
      image: 'yaac-test-proxy',
      containerName: 'yaac-proxy-test',
      hostPort: '19255',
      network: 'yaac-test-sessions',
      authSecret: testAuthSecret,
      requirePrebuilt: true,
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
})
