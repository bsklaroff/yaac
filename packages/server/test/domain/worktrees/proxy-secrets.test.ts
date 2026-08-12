import { describe, it, expect, afterEach } from 'vitest'
import { resolveProxySecrets } from '#domain/worktrees/proxy-secrets'

const SAVED = { ...process.env }

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key]
  }
  Object.assign(process.env, SAVED)
})

describe('resolveProxySecrets', () => {
  it('resolves each configured name to its value', () => {
    process.env.YAAC_TEST_TOKEN = 'ghp_test'
    expect(resolveProxySecrets({
      envSecretProxy: { YAAC_TEST_TOKEN: { hosts: ['api.github.com'] } },
    })).toEqual({ YAAC_TEST_TOKEN: 'ghp_test' })
  })

  it('drops a configured name with nothing behind it', () => {
    delete process.env.YAAC_TEST_ABSENT
    process.env.YAAC_TEST_TOKEN = 'ghp_test'
    // Passing it through empty would have the proxy inject a blank header,
    // which fails the upstream call looking like a bad credential rather
    // than a missing one.
    expect(resolveProxySecrets({
      envSecretProxy: {
        YAAC_TEST_TOKEN: { hosts: ['api.github.com'] },
        YAAC_TEST_ABSENT: { hosts: ['api.example.com'] },
      },
    })).toEqual({ YAAC_TEST_TOKEN: 'ghp_test' })
  })

  it('answers empty for a project that proxies none', () => {
    expect(resolveProxySecrets({})).toEqual({})
  })
})
