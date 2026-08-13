import { describe, it, expect } from 'vitest'
import { buildRulesFromConfig } from '#drivers/k8s/egress/proxy-client'

describe('buildRulesFromConfig', () => {
  it('defaults to an authorization header with Bearer prefix when no header/prefix specified', () => {
    const rules = buildRulesFromConfig(
      {
        GITHUB_TOKEN: {
          hosts: ['api.github.com'],
        },
      },
      ['GITHUB_TOKEN'],
    )
    expect(rules).toHaveLength(1)
    expect(rules[0]).toEqual({
      hostPattern: 'api.github.com',
      pathPattern: '/*',
      injections: [{
        action: 'set_header', name: 'authorization', secretRef: 'GITHUB_TOKEN', prefix: 'Bearer ',
      }],
    })
  })

  it('never embeds the secret value in the rule', () => {
    const rules = buildRulesFromConfig(
      { MY_KEY: { hosts: ['api.example.com'], header: 'x-api-key' } },
      ['MY_KEY'],
    )
    expect(JSON.stringify(rules)).not.toContain('super-secret')
  })

  it('uses custom header without prefix by default', () => {
    const rules = buildRulesFromConfig(
      {
        ANTHROPIC_API_KEY: {
          hosts: ['api.anthropic.com'],
          header: 'x-api-key',
        },
      },
      ['ANTHROPIC_API_KEY'],
    )
    expect(rules).toHaveLength(1)
    expect(rules[0]).toEqual({
      hostPattern: 'api.anthropic.com',
      pathPattern: '/*',
      injections: [{ action: 'set_header', name: 'x-api-key', secretRef: 'ANTHROPIC_API_KEY' }],
    })
  })

  it('applies explicit prefix to custom header', () => {
    const rules = buildRulesFromConfig(
      {
        MY_TOKEN: {
          hosts: ['api.example.com'],
          header: 'x-custom',
          prefix: 'Token ',
        },
      },
      ['MY_TOKEN'],
    )
    expect(rules[0].injections[0].prefix).toBe('Token ')
    expect(rules[0].injections[0].secretRef).toBe('MY_TOKEN')
  })

  it('builds body param injection rule', () => {
    const rules = buildRulesFromConfig(
      {
        GITHUB_CLIENT_ID: {
          hosts: ['github.com'],
          path: '/login/oauth/*',
          bodyParam: 'client_id',
        },
      },
      ['GITHUB_CLIENT_ID'],
    )
    expect(rules).toHaveLength(1)
    expect(rules[0]).toEqual({
      hostPattern: 'github.com',
      pathPattern: '/login/oauth/*',
      injections: [{ action: 'replace_body_param', name: 'client_id', secretRef: 'GITHUB_CLIENT_ID' }],
    })
  })

  it('allows overriding the default Bearer prefix', () => {
    const rules = buildRulesFromConfig(
      {
        MY_TOKEN: {
          hosts: ['api.custom.com'],
          prefix: 'Basic ',
        },
      },
      ['MY_TOKEN'],
    )
    expect(rules[0].injections).toEqual([
      { action: 'set_header', name: 'authorization', secretRef: 'MY_TOKEN', prefix: 'Basic ' },
    ])
  })

  it('skips a configured name the caller resolved no value for', () => {
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (msg: string) => warns.push(msg)

    const rules = buildRulesFromConfig(
      {
        MISSING_TOKEN: {
          hosts: ['api.example.com'],
          header: 'authorization',
        },
      },
      [],
    )

    console.warn = origWarn
    expect(rules).toHaveLength(0)
    expect(warns[0]).toContain('MISSING_TOKEN has no value available')
  })

  it('handles multiple env vars and hosts', () => {
    const rules = buildRulesFromConfig(
      {
        GITHUB_TOKEN: {
          hosts: ['api.github.com', 'github.com'],
        },
        ANTHROPIC_API_KEY: {
          hosts: ['api.anthropic.com'],
          header: 'x-api-key',
        },
      },
      ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY'],
    )
    expect(rules).toHaveLength(3) // 2 for github + 1 for anthropic
  })

  it('uses custom path pattern', () => {
    const rules = buildRulesFromConfig(
      {
        GOOGLE_CLIENT_SECRET: {
          hosts: ['oauth2.googleapis.com'],
          path: '/token',
          bodyParam: 'client_secret',
        },
      },
      ['GOOGLE_CLIENT_SECRET'],
    )
    expect(rules[0].pathPattern).toBe('/token')
  })

  it('defaults path to /* when not specified', () => {
    const rules = buildRulesFromConfig(
      {
        MY_KEY: {
          hosts: ['api.example.com'],
          header: 'x-api-key',
        },
      },
      ['MY_KEY'],
    )
    expect(rules[0].pathPattern).toBe('/*')
  })

  it('builds client credential pair rules together', () => {
    const rules = buildRulesFromConfig(
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
      ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
    )
    expect(rules).toHaveLength(2)
    expect(rules[0].injections[0]).toEqual({
      action: 'replace_body_param', name: 'client_id', secretRef: 'GITHUB_CLIENT_ID',
    })
    expect(rules[1].injections[0]).toEqual({
      action: 'replace_body_param', name: 'client_secret', secretRef: 'GITHUB_CLIENT_SECRET',
    })
  })
})
