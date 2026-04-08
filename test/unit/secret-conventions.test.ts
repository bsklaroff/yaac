import { describe, it, expect } from 'vitest'
import { buildInjectionRules, buildRulesFromConfig } from '@/lib/secret-conventions'

describe('buildInjectionRules', () => {
  it('builds rules for GITHUB_TOKEN', () => {
    const rules = buildInjectionRules([{ name: 'GITHUB_TOKEN', value: 'ghp_test123' }])
    expect(rules).toHaveLength(3) // api.github.com, github.com, raw.githubusercontent.com
    expect(rules[0]).toEqual({
      hostPattern: 'api.github.com',
      pathPattern: '/*',
      injections: [{ action: 'set_header', name: 'authorization', value: 'Bearer ghp_test123' }],
    })
  })

  it('builds rules for ANTHROPIC_API_KEY', () => {
    const rules = buildInjectionRules([{ name: 'ANTHROPIC_API_KEY', value: 'sk-ant-test' }])
    expect(rules).toHaveLength(1)
    expect(rules[0].injections).toEqual([
      { action: 'set_header', name: 'x-api-key', value: 'sk-ant-test' },
      { action: 'remove_header', name: 'authorization' },
    ])
  })

  it('skips unknown secret names', () => {
    const rules = buildInjectionRules([{ name: 'MY_CUSTOM_TOKEN', value: 'secret' }])
    expect(rules).toHaveLength(0)
  })
})

describe('buildRulesFromConfig', () => {
  it('builds rules for known env vars with config-specified hosts', () => {
    const rules = buildRulesFromConfig(
      { GITHUB_TOKEN: ['api.github.com'] },
      { GITHUB_TOKEN: 'ghp_test' },
    )
    expect(rules).toHaveLength(1)
    expect(rules[0]).toEqual({
      hostPattern: 'api.github.com',
      pathPattern: '/*',
      injections: [{ action: 'set_header', name: 'authorization', value: 'Bearer ghp_test' }],
    })
  })

  it('falls back to Authorization: Bearer for unknown env vars', () => {
    const rules = buildRulesFromConfig(
      { MY_TOKEN: ['api.custom.com'] },
      { MY_TOKEN: 'secret123' },
    )
    expect(rules).toHaveLength(1)
    expect(rules[0].injections).toEqual([
      { action: 'set_header', name: 'authorization', value: 'Bearer secret123' },
    ])
  })

  it('skips env vars that are not set', () => {
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (msg: string) => warns.push(msg)

    const rules = buildRulesFromConfig(
      { MISSING_TOKEN: ['api.example.com'] },
      {},
    )

    console.warn = origWarn
    expect(rules).toHaveLength(0)
    expect(warns[0]).toContain('MISSING_TOKEN is not set')
  })

  it('handles multiple env vars and hosts', () => {
    const rules = buildRulesFromConfig(
      {
        GITHUB_TOKEN: ['api.github.com', 'github.com'],
        ANTHROPIC_API_KEY: ['api.anthropic.com'],
      },
      {
        GITHUB_TOKEN: 'ghp_test',
        ANTHROPIC_API_KEY: 'sk-ant-test',
      },
    )
    expect(rules).toHaveLength(3) // 2 for github + 1 for anthropic
  })
})
