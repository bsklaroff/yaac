import readline from 'node:readline/promises'
import { Writable } from 'node:stream'
import { text } from 'node:stream/consumers'
import { api, resolveProject } from '#commands/api'
import type { ProjectEnvVar, SecretProxyRule } from '@yaac/shared/types'

export interface ConfigEnvOptions {
  secret?: boolean
  host: string[]
  path?: string
  header?: string
  prefix?: string
  bodyParam?: string
  unset?: string
}

/** Where a secret is injected, as the webapp's row summarizes it. */
function ruleSummary(rule: SecretProxyRule | undefined): string {
  if (!rule) return 'no rule'
  const where = rule.bodyParam !== undefined
    ? `body ${rule.bodyParam}`
    : `header ${rule.header ?? 'authorization'}${rule.prefix ? ` "${rule.prefix}"` : ''}`
  const path = rule.path !== undefined && rule.path !== '/*' ? ` ${rule.path}` : ''
  return `${rule.hosts.join(', ')}${path} · ${where}`
}

function printEnv(name: string, vars: ProjectEnvVar[]): void {
  if (vars.length === 0) {
    console.log(`${name} has no environment variables or secrets.`)
    return
  }
  const plain = vars.filter((v) => !v.secret)
  const secrets = vars.filter((v) => v.secret)
  if (plain.length > 0) console.log(`Variables in ${name}:\n${plain.map((v) => `  ${v.name}=${v.value ?? ''}`).join('\n')}`)
  if (secrets.length > 0) {
    console.log(`Secrets in ${name}:\n${secrets.map((v) =>
      `  ${v.name}  ${v.hasValue ? '********' : 'no value stored'}  ${ruleSummary(v.rule)}`).join('\n')}`)
  }
}

/**
 * A secret's value, from stdin rather than argv so it stays out of shell
 * history and `ps`. On a terminal it is asked for without echo. Blank keeps
 * the value already stored, to change only the rule.
 */
async function readSecretValue(name: string): Promise<string> {
  if (!process.stdin.isTTY) return (await text(process.stdin)).replace(/\r?\n$/, '')
  // The interface puts the terminal in raw mode, so it comes first: a
  // value typed after the prompt must not be echoed by the terminal.
  const muted = new Writable({ write: (_chunk, _enc, done) => done() })
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true })
  process.stderr.write(`Value of ${name} (not shown; blank keeps the stored one): `)
  try {
    return await rl.question('')
  } finally {
    rl.close()
    process.stderr.write('\n')
  }
}

/**
 * `yaac config env <project> [NAME=value...]`: list a project's environment
 * variables and secrets (values masked), set plain variables, set one
 * secret with `--secret NAME` and its proxy rule, or remove one with
 * `--unset NAME`. The rule defaults match the webapp's: path `/*`, header
 * `authorization` with a `Bearer ` prefix (no prefix once `--header` names
 * another). Under containerless the workspace gets the secret's real value
 * and the rule is stored but unused.
 */
export async function configEnv(project: string, assignments: string[], opts: ConfigEnvOptions): Promise<void> {
  const { id: projectId, name } = await resolveProject(project)
  const env = api.project[':projectId'].env
  const ruleGiven = opts.host.length > 0 || opts.path !== undefined || opts.header !== undefined
    || opts.prefix !== undefined || opts.bodyParam !== undefined

  if (opts.unset !== undefined) {
    if (assignments.length > 0 || opts.secret === true || ruleGiven) {
      throw new Error('Pass --unset on its own, without variables or secret options.')
    }
    const target = (await env.$get({ param: { projectId } })).vars.find((v) => v.name === opts.unset)
    if (!target) throw new Error(`${name} has no variable or secret ${opts.unset}.`)
    await env[':id'].$delete({ param: { projectId, id: target.id } })
    console.log(`Removed ${target.name} from ${name}. Workspaces created from now on start without it.`)
    return
  }

  if (opts.secret === true) {
    const [secretName] = assignments
    if (assignments.length !== 1 || secretName.includes('=')) {
      throw new Error('Pass --secret one NAME without a value; the value is read from stdin.')
    }
    if (opts.host.length === 0) throw new Error('A secret needs at least one --host whose requests it is injected into.')
    if (opts.bodyParam !== undefined && (opts.header !== undefined || opts.prefix !== undefined)) {
      throw new Error('Pass --header (and --prefix) or --body-param, not both.')
    }
    const rule: SecretProxyRule = {
      hosts: opts.host,
      path: opts.path ?? '/*',
      ...(opts.bodyParam !== undefined
        ? { bodyParam: opts.bodyParam }
        : { header: opts.header ?? 'authorization', prefix: opts.prefix ?? (opts.header === undefined ? 'Bearer ' : '') }),
    }
    const value = await readSecretValue(secretName)
    const { var: saved } = await env.$put({
      param: { projectId },
      json: { name: secretName, secret: true, rule, ...(value === '' ? {} : { value }) },
    })
    console.log(`Secret ${saved.name} in ${name} is stored, for ${ruleSummary(saved.rule)}. `
      + 'Applies to workspaces created from now on.')
    return
  }
  if (ruleGiven) throw new Error('--host, --path, --header, --prefix and --body-param describe a secret; pass --secret too.')

  if (assignments.length === 0) {
    printEnv(name, (await env.$get({ param: { projectId } })).vars)
    return
  }
  const pairs = assignments.map((arg) => {
    const eq = arg.indexOf('=')
    if (eq < 1) throw new Error(`${arg} is not NAME=value; set a secret with --secret NAME, its value on stdin.`)
    return { name: arg.slice(0, eq), value: arg.slice(eq + 1) }
  })
  const saved: string[] = []
  for (const pair of pairs) saved.push((await env.$put({ param: { projectId }, json: pair })).var.name)
  console.log(`Set ${saved.join(', ')} in ${name}. Applies to workspaces created from now on.`)
}
