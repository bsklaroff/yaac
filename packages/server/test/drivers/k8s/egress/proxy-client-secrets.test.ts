import { describe, it, expect } from 'vitest'
import { buildRulesFromSecrets } from '#drivers/k8s/egress/proxy-client'

describe('buildRulesFromSecrets', () => {
  it('defaults to an authorization header with Bearer prefix when no header/prefix specified', () => {
    const rules = buildRulesFromSecrets(
      'demo',
      {
        GITHUB_TOKEN: {
          hosts: ['api.github.com'],
        },
      },
    )
    expect(rules).toHaveLength(1)
    expect(rules[0]).toEqual({
      hostPattern: 'api.github.com',
      pathPattern: '/*',
      injections: [{
        action: 'set_header', name: 'authorization', secretRef: 'demo/GITHUB_TOKEN', prefix: 'Bearer ',
      }],
    })
  })

  it('never embeds the secret value in the rule', () => {
    const rules = buildRulesFromSecrets(
      'demo',
      { MY_KEY: { hosts: ['api.example.com'], header: 'x-api-key' } },
    )
    expect(JSON.stringify(rules)).not.toContain('super-secret')
  })

  it('uses custom header without prefix by default', () => {
    const rules = buildRulesFromSecrets(
      'demo',
      {
        ANTHROPIC_API_KEY: {
          hosts: ['api.anthropic.com'],
          header: 'x-api-key',
        },
      },
    )
    expect(rules).toHaveLength(1)
    expect(rules[0]).toEqual({
      hostPattern: 'api.anthropic.com',
      pathPattern: '/*',
      injections: [{ action: 'set_header', name: 'x-api-key', secretRef: 'demo/ANTHROPIC_API_KEY' }],
    })
  })

  it('applies explicit prefix to custom header', () => {
    const rules = buildRulesFromSecrets(
      'demo',
      {
        MY_TOKEN: {
          hosts: ['api.example.com'],
          header: 'x-custom',
          prefix: 'Token ',
        },
      },
    )
    expect(rules[0].injections[0].prefix).toBe('Token ')
    expect(rules[0].injections[0].secretRef).toBe('demo/MY_TOKEN')
  })

  it('builds body param injection rule', () => {
    const rules = buildRulesFromSecrets(
      'demo',
      {
        GITHUB_CLIENT_ID: {
          hosts: ['github.com'],
          path: '/login/oauth/*',
          bodyParam: 'client_id',
        },
      },
    )
    expect(rules).toHaveLength(1)
    expect(rules[0]).toEqual({
      hostPattern: 'github.com',
      pathPattern: '/login/oauth/*',
      injections: [{ action: 'replace_body_param', name: 'client_id', secretRef: 'demo/GITHUB_CLIENT_ID' }],
    })
  })

  it('allows overriding the default Bearer prefix', () => {
    const rules = buildRulesFromSecrets(
      'demo',
      {
        MY_TOKEN: {
          hosts: ['api.custom.com'],
          prefix: 'Basic ',
        },
      },
    )
    expect(rules[0].injections).toEqual([
      { action: 'set_header', name: 'authorization', secretRef: 'demo/MY_TOKEN', prefix: 'Basic ' },
    ])
  })

  it('builds a rule for every secret it is given, having been given only usable ones', () => {
    // Which secrets HAVE a value is the caller's question — it holds the
    // rows — and it hands over only those, so a name with nothing behind it
    // never reaches here to become a rule that injects an empty header.
    expect(buildRulesFromSecrets('demo', {})).toEqual([])
  })

  it('handles multiple env vars and hosts', () => {
    const rules = buildRulesFromSecrets(
      'demo',
      {
        GITHUB_TOKEN: {
          hosts: ['api.github.com', 'github.com'],
        },
        ANTHROPIC_API_KEY: {
          hosts: ['api.anthropic.com'],
          header: 'x-api-key',
        },
      },
    )
    expect(rules).toHaveLength(3) // 2 for github + 1 for anthropic
  })

  it('uses custom path pattern', () => {
    const rules = buildRulesFromSecrets(
      'demo',
      {
        GOOGLE_CLIENT_SECRET: {
          hosts: ['oauth2.googleapis.com'],
          path: '/token',
          bodyParam: 'client_secret',
        },
      },
    )
    expect(rules[0].pathPattern).toBe('/token')
  })

  it('defaults path to /* when not specified', () => {
    const rules = buildRulesFromSecrets(
      'demo',
      {
        MY_KEY: {
          hosts: ['api.example.com'],
          header: 'x-api-key',
        },
      },
    )
    expect(rules[0].pathPattern).toBe('/*')
  })

  it('builds client credential pair rules together', () => {
    const rules = buildRulesFromSecrets(
      'demo',
      {
        GITHUB_CLIENT_ID: {
          hosts: ['github.com'],
          path: '/login/oauth/*',
          bodyParam: 'client_id',
        },
        GITHUB_CLIENT_SECRET: {
          hosts: ['github.com'],
          path: '/login/oauth/*',
          bodyParam: 'client_secret',
        },
      },
    )
    expect(rules).toHaveLength(2)
    expect(rules[0].injections[0]).toEqual({
      action: 'replace_body_param', name: 'client_id', secretRef: 'demo/GITHUB_CLIENT_ID',
    })
    expect(rules[1].injections[0]).toEqual({
      action: 'replace_body_param', name: 'client_secret', secretRef: 'demo/GITHUB_CLIENT_SECRET',
    })
  })
})
