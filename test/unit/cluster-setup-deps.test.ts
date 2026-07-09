import { describe, it, expect } from 'vitest'
import { streamingClusterSetupDeps } from '@/lib/k8s/cluster-setup'

describe('streamingClusterSetupDeps', () => {
  it('forwards progress to the given log', () => {
    const lines: string[] = []
    const deps = streamingClusterSetupDeps((m) => lines.push(m))
    deps.log('Creating cluster')
    expect(lines).toEqual(['Creating cluster'])
  })

  it('auto-approves confirms (no TTY; the caller already consented)', async () => {
    const deps = streamingClusterSetupDeps(() => { /* ignore */ })
    expect(await deps.confirm('delete the existing cluster?')).toBe(true)
  })
})
