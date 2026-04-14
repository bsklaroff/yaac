import { describe, it, expect } from 'vitest'
import { buildRulesFromConfig } from '@/lib/container/proxy-client'

describe('buildRulesFromConfig', () => {
  it('defaults to Authorization: Bearer when no header/prefix specified', () => {
    const rules = buildRulesFromConfig(
      {
        GITHUB_TOKEN: {
          hosts: ['api.github.com'],
        },
      },
      { GITHUB_TOKEN: 'ghp_test' },
    )
    expect(rules).toHaveLength(1)
    expect(rules[0]).toEqual({
      hostPattern: 'api.github.com',
      pathPattern: '/*',
      injections: [{ action: 'set_header', name: 'authorization', value: 'Bearer ghp_test' }],
    })
  })

  it('uses custom header without prefix by default', () => {
    const rules = buildRulesFromConfig(
      {
        ANTHROPIC_API_KEY: {
          hosts: ['api.anthropic.com'],
          header: 'x-api-key',
        },
      },
      { ANTHROPIC_API_KEY: 'sk-ant-test' },
    )
    expect(rules).toHaveLength(1)
    expect(rules[0]).toEqual({
      hostPattern: 'api.anthropic.com',
      pathPattern: '/*',
      injections: [{ action: 'set_header', name: 'x-api-key', value: 'sk-ant-test' }],
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
      { MY_TOKEN: 'abc' },
    )
    expect(rules[0].injections[0].value).toBe('Token abc')
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
      { GITHUB_CLIENT_ID: 'my-client-id' },
    )
    expect(rules).toHaveLength(1)
    expect(rules[0]).toEqual({
      hostPattern: 'github.com',
      pathPattern: '/login/oauth/*',
      injections: [{ action: 'replace_body_param', name: 'client_id', value: 'my-client-id' }],
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
      { MY_TOKEN: 'secret123' },
    )
    expect(rules[0].injections).toEqual([
      { action: 'set_header', name: 'authorization', value: 'Basic secret123' },
    ])
  })

  it('skips env vars that are not set', () => {
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
      {},
    )

    console.warn = origWarn
    expect(rules).toHaveLength(0)
    expect(warns[0]).toContain('MISSING_TOKEN is not set')
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
      {
        GITHUB_TOKEN: 'ghp_test',
        ANTHROPIC_API_KEY: 'sk-ant-test',
      },
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
      { GOOGLE_CLIENT_SECRET: 'secret' },
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
      { MY_KEY: 'val' },
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
      {
        GITHUB_CLIENT_ID: 'my-id',
        GITHUB_CLIENT_SECRET: 'my-secret',
      },
    )
    expect(rules).toHaveLength(2)
    expect(rules[0].injections[0]).toEqual({
      action: 'replace_body_param', name: 'client_id', value: 'my-id',
    })
    expect(rules[1].injections[0]).toEqual({
      action: 'replace_body_param', name: 'client_secret', value: 'my-secret',
    })
  })
})
