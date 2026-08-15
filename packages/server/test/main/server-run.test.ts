import { describe, it, expect, vi, afterEach } from 'vitest'
import { torCoverageWarning } from '#main/server-run'

describe('torCoverageWarning', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('says nothing when Tor is off, under either driver', () => {
    expect(torCoverageWarning('containerless')).toBeUndefined()
    expect(torCoverageWarning('k8s')).toBeUndefined()
  })

  it('says nothing under k8s, where the egress proxy covers a pod entirely', () => {
    vi.stubEnv('YAAC_USE_TOR', '1')
    expect(torCoverageWarning('k8s')).toBeUndefined()
  })

  it('warns under containerless, naming what is and is not routed', () => {
    vi.stubEnv('YAAC_USE_TOR', '1')
    const warning = torCoverageWarning('containerless')
    // The whole point of the warning is that it distinguishes the two halves:
    // an operator who reads "Tor is not supported here" would wrongly stop
    // trusting the server's own git, which IS routed.
    expect(warning).toMatch(/NOT go through Tor/)
    expect(warning).toMatch(/git operations are routed/)
  })

  it('reads the flag with the same truthy semantics as the rest of the server', () => {
    // `useTor` treats "0"/"false"/empty as off — the warning must not fire on
    // a variable that is set but disabled, which is how it would be spelled
    // by someone turning Tor off in an environment file.
    vi.stubEnv('YAAC_USE_TOR', '0')
    expect(torCoverageWarning('containerless')).toBeUndefined()
    vi.stubEnv('YAAC_USE_TOR', 'yes')
    expect(torCoverageWarning('containerless')).toBeDefined()
  })
})
