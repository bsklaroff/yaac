import { describe, it, expect, afterEach } from 'vitest'
import { formatSshCommand, getGitUserConfig, torSshOpts } from '#git'

describe('getGitUserConfig', () => {
  it('returns name and email or null', async () => {
    const result = await getGitUserConfig()
    if (result) {
      expect(typeof result.name).toBe('string')
      expect(typeof result.email).toBe('string')
    } else {
      expect(result).toBeNull()
    }
  })
})

describe('torSshOpts', () => {
  const originalUseTor = process.env.YAAC_USE_TOR
  const originalUrl = process.env.YAAC_HOST_TOR_SOCKS_URL

  afterEach(() => {
    if (originalUseTor === undefined) delete process.env.YAAC_USE_TOR
    else process.env.YAAC_USE_TOR = originalUseTor
    if (originalUrl === undefined) delete process.env.YAAC_HOST_TOR_SOCKS_URL
    else process.env.YAAC_HOST_TOR_SOCKS_URL = originalUrl
  })

  it('returns [] when YAAC_USE_TOR is unset', () => {
    delete process.env.YAAC_USE_TOR
    expect(torSshOpts()).toEqual([])
  })

  it('emits -o ProxyCommand with the default SOCKS host:port', () => {
    process.env.YAAC_USE_TOR = '1'
    delete process.env.YAAC_HOST_TOR_SOCKS_URL
    const opts = torSshOpts()
    expect(opts).toEqual(['-o', 'ProxyCommand=nc -X 5 -x 127.0.0.1:9050 %h %p'])
  })

  it('honors YAAC_HOST_TOR_SOCKS_URL', () => {
    process.env.YAAC_USE_TOR = '1'
    process.env.YAAC_HOST_TOR_SOCKS_URL = 'socks5h://10.0.0.1:9150'
    const opts = torSshOpts()
    expect(opts).toEqual(['-o', 'ProxyCommand=nc -X 5 -x 10.0.0.1:9150 %h %p'])
  })
})

describe('formatSshCommand', () => {
  it('leaves plain args unquoted', () => {
    expect(formatSshCommand(['ssh', '-F', '/dev/null', '-i', '/k'])).toBe(
      'ssh -F /dev/null -i /k',
    )
  })

  it('single-quotes args containing whitespace', () => {
    const cmd = formatSshCommand(['-o', 'ProxyCommand=nc -X 5 %h %p'])
    expect(cmd).toBe("-o 'ProxyCommand=nc -X 5 %h %p'")
  })

  it('escapes embedded single quotes', () => {
    const cmd = formatSshCommand(['-o', "Foo=bar's baz"])
    expect(cmd).toBe(`-o 'Foo=bar'\\''s baz'`)
  })

  it('quotes the empty string', () => {
    expect(formatSshCommand([''])).toBe("''")
  })

  it('quotes shell metacharacters even without whitespace', () => {
    expect(formatSshCommand(['a;b', 'c$d'])).toBe("'a;b' 'c$d'")
  })
})
