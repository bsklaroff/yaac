// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

vi.mock('#lib/clusterApi', () => ({
  streamClusterSetup: vi.fn(),
  getClusterCheck: vi.fn(),
}))

import { ClusterSetup } from '#components/ClusterSetup'
import { streamClusterSetup } from '#lib/clusterApi'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ClusterSetup', () => {
  it('lists the failing checks and their fixes', () => {
    render(
      <ClusterSetup
        results={[{ name: 'kind', status: 'fail', detail: 'no cluster', fix: 'run yaac cluster setup' }]}
        onReady={() => { /* noop */ }}
      />,
    )
    expect(screen.getByText(/kind: no cluster/)).toBeTruthy()
    expect(screen.getByText(/run yaac cluster setup/)).toBeTruthy()
  })

  it('runs setup, streams progress, and calls onReady on success', async () => {
    vi.mocked(streamClusterSetup).mockImplementation((onProgress: (l: string) => void) => {
      onProgress('Creating cluster')
      return Promise.resolve(true)
    })
    const onReady = vi.fn()
    render(<ClusterSetup results={[]} onReady={onReady} />)
    fireEvent.click(screen.getByText('Set up'))
    await waitFor(() => expect(onReady).toHaveBeenCalled())
    expect(vi.mocked(streamClusterSetup)).toHaveBeenCalled()
  })

  it('surfaces the error when setup fails', async () => {
    vi.mocked(streamClusterSetup).mockRejectedValue(new Error('podman not found'))
    render(<ClusterSetup results={[]} onReady={() => { /* noop */ }} />)
    fireEvent.click(screen.getByText('Set up'))
    await waitFor(() => expect(screen.getByText(/podman not found/)).toBeTruthy())
  })
})
