import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { once } from 'node:events'
import { LiveTunnels } from 'yaac-proxy-sidecar/live-tunnels'

describe('LiveTunnels', () => {
  it('drops the tunnels a changed admission no longer admits as accepted, and only those', async () => {
    const tunnels = new LiveTunnels()
    const kept = new PassThrough()
    const revoked = new PassThrough()
    const rerouted = new PassThrough()
    const other = new PassThrough()
    tunnels.add('wt1', kept, 'registry.npmjs.org', 'none')
    tunnels.add('wt1', revoked, 'evil.example', 'none')
    tunnels.add('wt1', rerouted, 'api.example', 'rules-v1')
    tunnels.add('wt2', other, 'evil.example', 'none')

    // A narrowed registration: evil.example is gone and api.example's rules
    // changed; registry.npmjs.org is admitted exactly as it was.
    const admit = (host: string): string | null =>
      host === 'registry.npmjs.org' ? 'none' : host === 'api.example' ? 'rules-v2' : null
    expect(tunnels.revoke('wt1', admit).sort()).toEqual(['api.example', 'evil.example'])
    expect([kept.destroyed, revoked.destroyed, rerouted.destroyed, other.destroyed])
      .toEqual([false, true, true, false])

    // A destroyed tunnel is forgotten once it closes, so a later
    // deregistration drops only what is still open.
    await Promise.all([once(revoked, 'close'), once(rerouted, 'close')])
    expect(tunnels.revoke('wt1', null)).toEqual(['registry.npmjs.org'])
    expect(kept.destroyed).toBe(true)
    await once(kept, 'close')
    expect(tunnels.revoke('wt1', null)).toEqual([])
    expect(other.destroyed).toBe(false)
  })
})
