import { describe, it, expect, vi, afterEach } from 'vitest'
import { PgRelayClient } from '@/lib/container/pg-relay'
import { podman } from '@/lib/container/runtime'

vi.mock('@/lib/container/runtime', () => ({
  podman: { getContainer: vi.fn() },
}))

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockGetContainer = vi.mocked(podman.getContainer)

describe('PgRelayClient', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    mockGetContainer.mockReset()
  })

  it('skips startup when container is already running', async () => {
    const mockInspect = vi.fn().mockResolvedValue({
      State: { Running: true },
      NetworkSettings: {
        Networks: { 'yaac-sessions': { IPAddress: '10.89.0.5' } },
      },
    })
    mockGetContainer.mockReturnValue({ inspect: mockInspect } as never)

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
    mockGetContainer.mockReturnValue({ inspect: mockInspect } as never)

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
    mockGetContainer.mockReturnValue({ inspect: mockInspect } as never)

    const client = new PgRelayClient()

    await client.ensureRunning({ enabled: true, containerPort: 5433 })

    expect(client.containerPort).toBe(5433)
  })

  it('throws when accessing ip before ensureRunning', () => {
    const client = new PgRelayClient()

    expect(() => client.ip).toThrow('PG relay not started')
  })

  it('stop handles already-stopped containers gracefully', async () => {
    const mockStop = vi.fn().mockRejectedValue(new Error('no such container'))
    const mockRemove = vi.fn()
    mockGetContainer.mockReturnValue({ stop: mockStop, remove: mockRemove } as never)

    const client = new PgRelayClient()

    // Should not throw
    await client.stop()
  })
})
