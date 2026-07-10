import { describe, it, expect } from 'vitest'
import { SYSTEM_ROOTS_PATH, combineCaBundle } from 'yaac-proxy-sidecar/ca-bundle'

const ROOT = '-----BEGIN CERTIFICATE-----\nROOTBYTES\n-----END CERTIFICATE-----\n'
const CA = '-----BEGIN CERTIFICATE-----\nPROXYCA\n-----END CERTIFICATE-----\n'

describe('combineCaBundle', () => {
  it('contains both the public roots and the proxy CA (the union)', () => {
    const bundle = combineCaBundle(ROOT, CA)
    expect(bundle).toContain('ROOTBYTES')
    expect(bundle).toContain('PROXYCA')
    // Two distinct certs, roots first.
    expect((bundle.match(/BEGIN CERTIFICATE/g) ?? []).length).toBe(2)
    expect(bundle.indexOf('ROOTBYTES')).toBeLessThan(bundle.indexOf('PROXYCA'))
  })

  it('inserts a newline between blocks when the roots do not end with one', () => {
    // Without the separator the last root and the CA header would fuse onto
    // one line ("...END CERTIFICATE----------BEGIN CERTIFICATE...").
    const noTrailingNl = '-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----'
    const bundle = combineCaBundle(noTrailingNl, CA)
    expect(bundle).toBe(`${noTrailingNl}\n${CA}`)
    expect(bundle).not.toContain('CERTIFICATE----------BEGIN')
  })

  it('does not double a newline when the roots already end with one', () => {
    expect(combineCaBundle(ROOT, CA)).toBe(`${ROOT}${CA}`)
  })

  it('falls back to just the CA when roots are empty', () => {
    expect(combineCaBundle('', CA)).toBe(CA)
  })

  it('reads the public roots from the image ca-certificates path', () => {
    expect(SYSTEM_ROOTS_PATH).toBe('/etc/ssl/certs/ca-certificates.crt')
  })
})
