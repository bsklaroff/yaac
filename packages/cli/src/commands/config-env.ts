import readline from 'node:readline/promises'
import { Writable } from 'node:stream'
import { text } from 'node:stream/consumers'
import { api, resolveProject } from '#commands/api'
import type { ProjectEnvVar, ProjectRunSecret, SecretProxyRule } from '@yaac/shared/types'

export interface ConfigEnvOptions {
  secret?: boolean
  runSecret?: boolean
  site: string[]
  routine: string[]
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

async function printEnv(projectId: string, name: string, vars: ProjectEnvVar[], runSecrets: ProjectRunSecret[]): Promise<void> {
  if (vars.length === 0 && runSecrets.length === 0) {
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
  if (runSecrets.length === 0) return
  const [sites, routines] = await targetNames(projectId, runSecrets)
  console.log(`Run secrets in ${name}:\n${runSecrets.map((r) => {
    const to = [
      ...r.siteIds.map((id) => `site ${sites.get(id) ?? id}`),
      ...r.routineIds.map((id) => `routine ${routines.get(id) ?? id}`),
    ]
    return `  ${r.name}  ${r.hasValue ? '********' : 'no value stored'}  ${to.length > 0 ? to.join(', ') : 'given to nothing'}`
  }).join('\n')}`)
}

/** Site and routine names by id, for the run secrets' rows. Sites are only
 *  asked for when one is named, since containerless has none. */
async function targetNames(projectId: string, runSecrets: ProjectRunSecret[]): Promise<[Map<string, string>, Map<string, string>]> {
  const sites = runSecrets.some((r) => r.siteIds.length > 0)
    ? await api.site.list.$get({ query: { project: projectId } })
    : []
  const routines = (await api.routine.list.$get()).filter((r) => r.projectId === projectId)
  return [new Map(sites.map((s) => [s.id, s.name])), new Map(routines.map((r) => [r.id, `${r.name} (${r.id.slice(0, 8)})`]))]
}

/** The ids of the sites (by name) and routines (by id or unique id prefix)
 *  a run secret is given to. */
async function resolveTargets(projectId: string, opts: ConfigEnvOptions): Promise<{ siteIds: string[]; routineIds: string[] }> {
  const sites = opts.site.length > 0 ? await api.site.list.$get({ query: { project: projectId } }) : []
  const siteIds = opts.site.map((n) => {
    const site = sites.find((s) => s.name === n)
    if (!site) throw new Error(`No site "${n}" in this project. Run "yaac site list" to see them.`)
    return site.id
  })
  const routines = opts.routine.length > 0
    ? (await api.routine.list.$get()).filter((r) => r.projectId === projectId)
    : []
  const routineIds = opts.routine.map((token) => {
    const matches = routines.filter((r) => r.id.startsWith(token.trim().toLowerCase()))
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `No routine "${token}" in this project. Run "yaac routine list" to see them.`
        : `"${token}" matches more than one routine; use a longer prefix.`)
    }
    return matches[0].id
  })
  return { siteIds, routineIds }
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
 * variables, secrets and run secrets (values masked), set plain variables,
 * set one secret with `--secret NAME` and its proxy rule, set one run secret
 * with `--run-secret NAME` and the sites and routines it is given to, or
 * remove one with `--unset NAME`. The rule defaults match the webapp's: path
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
  const targetsGiven = opts.site.length > 0 || opts.routine.length > 0

  if (opts.unset !== undefined) {
    if (assignments.length > 0 || opts.secret === true || opts.runSecret === true || ruleGiven || targetsGiven) {
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
    const targets = await resolveTargets(projectId, opts)
    const value = await readSecretValue(secretName)
    const { secret: saved } = await run.$put({
      param: { projectId },
      json: { name: secretName, ...targets, ...(value === '' ? {} : { value }) },
    })
    const [sites, routines] = await targetNames(projectId, [saved])
    const to = [...saved.siteIds.map((id) => `site ${sites.get(id) ?? id}`), ...saved.routineIds.map((id) => `routine ${routines.get(id) ?? id}`)]
    console.log(`Run secret ${saved.name} in ${name} is stored, given to ${to.length > 0 ? to.join(', ') : 'nothing yet'}. `
      + 'Applies to releases and runs launched from now on.')
    return
  }
  if (targetsGiven) throw new Error('--site and --routine say what a run secret is given to; pass --run-secret too.')

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
    await printEnv(projectId, name, vars, secrets)
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
