import { describe, it, expect, vi, afterEach } from 'vitest'

describe('PgRelayClient', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('@/lib/podman')
    vi.resetModules()
  })

  it('skips startup when container is already running', async () => {
    const mockInspect = vi.fn().mockResolvedValue({
      State: { Running: true },
      NetworkSettings: {
        Networks: { 'yaac-sessions': { IPAddress: '10.89.0.5' } },
      },
    })
    const mockGetContainer = vi.fn().mockReturnValue({ inspect: mockInspect })

    vi.doMock('@/lib/podman', () => ({
      podman: { getContainer: mockGetContainer },
    }))

    const { PgRelayClient } = await import('@/lib/pg-relay')
    const client = new PgRelayClient()

    await client.ensureRunning()

    expect(mockGetContainer).toHaveBeenCalledWith('yaac-pg-relay')
    expect(client.ip).toBe('10.89.0.5')
  })

  it('uses default containerPort', async () => {
    const mockInspect = vi.fn().mockResolvedValue({
      State: { Running: true },
      NetworkSettings: {
        Networks: { 'yaac-sessions': { IPAddress: '10.89.0.5' } },
      },
    })
    vi.doMock('@/lib/podman', () => ({
      podman: { getContainer: vi.fn().mockReturnValue({ inspect: mockInspect }) },
    }))

    const { PgRelayClient } = await import('@/lib/pg-relay')
    const client = new PgRelayClient()

    await client.ensureRunning()

    expect(client.containerPort).toBe(5432)
  })

  it('uses custom containerPort from config', async () => {
    const mockInspect = vi.fn().mockResolvedValue({
      State: { Running: true },
      NetworkSettings: {
        Networks: { 'yaac-sessions': { IPAddress: '10.89.0.5' } },
      },
    })
    vi.doMock('@/lib/podman', () => ({
      podman: { getContainer: vi.fn().mockReturnValue({ inspect: mockInspect }) },
    }))

    const { PgRelayClient } = await import('@/lib/pg-relay')
    const client = new PgRelayClient()

    await client.ensureRunning({ containerPort: 5433 })

    expect(client.containerPort).toBe(5433)
  })

  it('throws when accessing ip before ensureRunning', async () => {
    const { PgRelayClient } = await import('@/lib/pg-relay')
    const client = new PgRelayClient()

    expect(() => client.ip).toThrow('PG relay not started')
  })

  it('stop handles already-stopped containers gracefully', async () => {
    const mockStop = vi.fn().mockRejectedValue(new Error('no such container'))
    const mockRemove = vi.fn()
    vi.doMock('@/lib/podman', () => ({
      podman: { getContainer: vi.fn().mockReturnValue({ stop: mockStop, remove: mockRemove }) },
    }))

    const { PgRelayClient } = await import('@/lib/pg-relay')
    const client = new PgRelayClient()

    // Should not throw
    await client.stop()
  })
})
