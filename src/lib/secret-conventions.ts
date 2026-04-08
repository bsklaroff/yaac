export interface Injection {
  action: 'set_header' | 'replace_header' | 'remove_header'
  name: string
  value?: string
}

export interface InjectionRule {
  hostPattern: string
  pathPattern: string
  injections: Injection[]
}

interface SecretConvention {
  hosts: string[]
  injections: Injection[]
}

const SECRET_CONVENTIONS: Record<string, SecretConvention> = {
  CLAUDE_CODE_OAUTH_TOKEN: {
    hosts: ['api.anthropic.com'],
    injections: [
      { action: 'replace_header', name: 'authorization', value: 'Bearer {value}' },
    ],
  },
  ANTHROPIC_API_KEY: {
    hosts: ['api.anthropic.com'],
    injections: [
      { action: 'set_header', name: 'x-api-key', value: '{value}' },
      { action: 'remove_header', name: 'authorization' },
    ],
  },
  GITHUB_TOKEN: {
    hosts: ['api.github.com', 'github.com', 'raw.githubusercontent.com'],
    injections: [
      { action: 'set_header', name: 'authorization', value: 'Bearer {value}' },
    ],
  },
  OPENAI_API_KEY: {
    hosts: ['api.openai.com'],
    injections: [
      { action: 'set_header', name: 'authorization', value: 'Bearer {value}' },
    ],
  },
  RESEND_API_KEY: {
    hosts: ['api.resend.com'],
    injections: [
      { action: 'set_header', name: 'authorization', value: 'Bearer {value}' },
    ],
  },
}

/**
 * Build injection rules from a list of named secrets (pivotal-wt1 style).
 */
export function buildInjectionRules(
  secrets: Array<{ name: string; value: string }>,
): InjectionRule[] {
  const rules: InjectionRule[] = []

  for (const secret of secrets) {
    const convention = SECRET_CONVENTIONS[secret.name]
    if (!convention) continue

    const resolvedInjections = convention.injections.map((inj) => ({
      ...inj,
      ...(inj.value !== undefined && { value: inj.value.replace('{value}', secret.value) }),
    }))

    for (const host of convention.hosts) {
      rules.push({
        hostPattern: host,
        pathPattern: '/*',
        injections: resolvedInjections,
      })
    }
  }

  return rules
}

/**
 * Build injection rules from yaac-config.json's envSecretProxy field.
 * Uses SECRET_CONVENTIONS for known env vars, falls back to Authorization: Bearer for unknown.
 */
export function buildRulesFromConfig(
  envSecretProxy: Record<string, string[]>,
  env: Record<string, string | undefined>,
): InjectionRule[] {
  const rules: InjectionRule[] = []

  for (const [envVar, hosts] of Object.entries(envSecretProxy)) {
    const value = env[envVar]
    if (!value) {
      console.warn(`Warning: ${envVar} is not set in the environment, skipping proxy rule`)
      continue
    }

    const convention = SECRET_CONVENTIONS[envVar]
    const injections: Injection[] = convention
      ? convention.injections.map((inj) => ({
        ...inj,
        ...(inj.value !== undefined && { value: inj.value.replace('{value}', value) }),
      }))
      : [{ action: 'set_header' as const, name: 'authorization', value: `Bearer ${value}` }]

    for (const host of hosts) {
      rules.push({
        hostPattern: host,
        pathPattern: '/*',
        injections,
      })
    }
  }

  return rules
}
