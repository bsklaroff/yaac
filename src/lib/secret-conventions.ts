import type { SecretProxyRule } from '@/types'

export interface Injection {
  action: 'set_header' | 'replace_header' | 'remove_header' | 'replace_body_param'
  name: string
  value?: string
}

export interface InjectionRule {
  hostPattern: string
  pathPattern: string
  injections: Injection[]
}

/**
 * Build proxy injection rules from yaac-config.json's envSecretProxy field.
 * Each entry maps an env var name to a SecretProxyRule that describes how to
 * inject the secret (as a header or body parameter).
 */
export function buildRulesFromConfig(
  envSecretProxy: Record<string, SecretProxyRule>,
  env: Record<string, string | undefined>,
): InjectionRule[] {
  const rules: InjectionRule[] = []

  for (const [envVar, rule] of Object.entries(envSecretProxy)) {
    const value = env[envVar]
    if (!value) {
      console.warn(`Warning: ${envVar} is not set in the environment, skipping proxy rule`)
      continue
    }

    const pathPattern = rule.path ?? '/*'

    let injections: Injection[]
    if (rule.bodyParam) {
      injections = [{ action: 'replace_body_param', name: rule.bodyParam, value }]
    } else {
      const headerName = rule.header ?? 'authorization'
      const prefix = rule.prefix ?? (rule.header ? '' : 'Bearer ')
      const headerValue = `${prefix}${value}`
      injections = [{ action: 'set_header', name: headerName, value: headerValue }]
    }

    for (const host of rule.hosts) {
      rules.push({ hostPattern: host, pathPattern, injections })
    }
  }

  return rules
}
