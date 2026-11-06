import readline from 'node:readline/promises'
import { Writable } from 'node:stream'
import { text } from 'node:stream/consumers'
import { api, resolveProject } from '#commands/api'
import type { ProjectEnvVar, ProjectRunSecret, SecretProxyRule } from '@yaac/shared/types'

export interface ConfigEnvOptions {
  secret?: boolean
  runSecret?: boolean
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

function printEnv(name: string, vars: ProjectEnvVar[], runSecrets: ProjectRunSecret[]): void {
  if (vars.length === 0 && runSecrets.length === 0) {
    console.log(`${name} has no environment variables or secrets.`)
    return
  }
  const plain = vars.filter((v) => !v.secret)
  const secrets = vars.filter((v) => v.secret)
  const masked = (hasValue: boolean): string => (hasValue ? '********' : 'no value stored')
  if (plain.length > 0) console.log(`Variables in ${name}:\n${plain.map((v) => `  ${v.name}=${v.value ?? ''}`).join('\n')}`)
  if (secrets.length > 0) {
    console.log(`Secrets in ${name}:\n${secrets.map((v) => `  ${v.name}  ${masked(v.hasValue)}  ${ruleSummary(v.rule)}`).join('\n')}`)
  }
  if (runSecrets.length > 0) {
    console.log(`Run secrets in ${name}:\n${runSecrets.map((r) => `  ${r.name}  ${masked(r.hasValue)}`).join('\n')}`)
  }
}

/**
 * A secret's value, from stdin rather than argv so it stays out of shell
 * history and `ps`. On a terminal it is asked for without echo. For a
 * proxied secret, blank keeps the value already stored, to change only the
 * rule; a run secret has none to keep.
 */
async function readSecretValue(name: string, blankKeeps = true): Promise<string> {
  if (!process.stdin.isTTY) return (await text(process.stdin)).replace(/\r?\n$/, '')
  // The interface puts the terminal in raw mode, so it comes first: a
  // value typed after the prompt must not be echoed by the terminal.
  const muted = new Writable({ write: (_chunk, _enc, done) => done() })
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true })
  process.stderr.write(`Value of ${name} (not shown${blankKeeps ? '; blank keeps the stored one' : ''}): `)
  try {
    return await rl.question('')
  } finally {
    rl.close()
    process.stderr.write('\n')
  }
}

/**
 * `yaac config env <project> [NAME=value...]`: list a project's environment
 * variables, secrets and run secrets (values masked), set plain variables,
 * set one secret with `--secret NAME` and its proxy rule, set one run secret
 * with `--run-secret NAME` (a workflow names the ones it gets), or remove
 * one with `--unset NAME`. The rule defaults match the webapp's: path
 * `/*`, header `authorization` with a `Bearer ` prefix (no prefix once
 * `--header` names another). Under containerless the workspace gets the
 * secret's real value and the rule is stored but unused.
 */
export async function configEnv(project: string, assignments: string[], opts: ConfigEnvOptions): Promise<void> {
  const { id: projectId, name } = await resolveProject(project)
  const env = api.project[':projectId'].env
  const run = api.project[':projectId']['run-secrets']
  const ruleGiven = opts.host.length > 0 || opts.path !== undefined || opts.header !== undefined
    || opts.prefix !== undefined || opts.bodyParam !== undefined

  if (opts.unset !== undefined) {
    if (assignments.length > 0 || opts.secret === true || opts.runSecret === true || ruleGiven) {
      throw new Error('Pass --unset on its own, without variables or secret options.')
    }
    const target = (await env.$get({ param: { projectId } })).vars.find((v) => v.name === opts.unset)
    if (target) {
      await env[':id'].$delete({ param: { projectId, id: target.id } })
      console.log(`Removed ${target.name} from ${name}. Workspaces created from now on start without it.`)
      return
    }
    const runTarget = (await run.$get({ param: { projectId } })).secrets.find((r) => r.name === opts.unset)
    if (!runTarget) throw new Error(`${name} has no variable or secret ${opts.unset}.`)
    await run[':id'].$delete({ param: { projectId, id: runTarget.id } })
    console.log(`Removed run secret ${runTarget.name} from ${name}. Workspaces launched from now on start without it.`)
    return
  }

  if (opts.runSecret === true) {
    const [secretName] = assignments
    if (assignments.length !== 1 || secretName.includes('=')) {
      throw new Error('Pass --run-secret one NAME without a value; the value is read from stdin.')
    }
    if (opts.secret === true || ruleGiven) throw new Error('A run secret has no proxy rule; pass --run-secret without --secret or rule options.')
    const value = await readSecretValue(secretName, false)
    if (value === '') throw new Error(`A run secret needs a value; give ${secretName}'s on stdin.`)
    const { secret: saved } = await run.$put({ param: { projectId }, json: { name: secretName, value } })
    console.log(`Run secret ${saved.name} in ${name} is stored. A workflow gets it once it names it `
      + `(yaac workflow edit ${name} <workflow> --file <path> --secret ${saved.name}).`)
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
    const [{ vars }, { secrets }] = await Promise.all([env.$get({ param: { projectId } }), run.$get({ param: { projectId } })])
    printEnv(name, vars, secrets)
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
