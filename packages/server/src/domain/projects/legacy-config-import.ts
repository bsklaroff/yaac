import fs from 'node:fs/promises'
import path from 'node:path'
import { credentialsDir, projectConfigDir } from '@yaac/shared/project-paths'
import { listProjectEnvVars, listProjectRows, upsertProjectEnvVar } from '#db'
import { serverLog } from '#log'
import { parseSecretProxyRule } from './env'
import type { SecretProxyRule } from '@yaac/shared/types'

/**
 * Move a pre-upgrade install's env settings out of `yaac-config.json` and
 * into rows, once, at startup (docs/legacy-compat-shims.md).
 *
 * The three keys this reads (`env`, `envPassthrough`, `envSecretProxy`) are
 * retired, and the parser now warns about them — but a warning alone would
 * mean an install that upgrades loses its worktree environment silently at
 * the next create, with the config file still sitting there looking like it
 * says what should happen. So the values move, and the keys are stripped so
 * the file stops disagreeing with the settings page.
 *
 * The two passthrough-shaped keys can only be resolved from the environment
 * this process happens to have, which is the very thing that made them a
 * problem: it is the server host's, and under `k8s` it holds nothing. That
 * is the best this can do, and it is why a secret that comes up empty is
 * imported as a valueless row and named in the log rather than dropped — the
 * rule survives, and the user supplies the value in the UI.
 *
 * Runs on every start rather than behind a flag: a project directory can
 * appear at any time (a restored backup, a second install's data dir), and
 * the pass is a no-op once the keys are gone.
 */

/** The one place left that reads an arbitrary name out of the host's env. */
function hostEnv(name: string): string | undefined {
  // eslint-disable-next-line no-process-env -- the retired envPassthrough/envSecretProxy keys named host variables; this shim is the last reader of them
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

/**
 * Where the proxy used to read secret values from — a merged map of every
 * value `envSecretProxy` ever resolved, across projects.
 *
 * Read here, never deleted here. A still-running proxy pod from before the
 * upgrade resolves every live worktree's injections out of this file, and
 * nothing rolls it at server start — so removing it here would take every
 * running worktree's credentials with it. The delete belongs where the new
 * proxy has proved it is up (`sweepLegacyProxySecretsFile`).
 */
export function legacyProxySecretsFile(): string {
  return path.join(credentialsDir(), 'proxy-secrets.json')
}

/**
 * The old proxy-secrets file, as a value source.
 *
 * It is the better source of the two, and under `k8s` the only one: the
 * server pod's environment holds nothing but what its Deployment states, so
 * `hostEnv` answers for nothing there, while this file holds every value the
 * install ever proxied. Read before the file is deleted, so an upgrade
 * recovers the secrets instead of importing valueless rows and removing the
 * one copy of what they were worth in the same pass.
 */
async function readLegacyProxySecrets(): Promise<Record<string, string>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(legacyProxySecretsFile(), 'utf8'))
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const secrets = (parsed as Record<string, unknown>).secrets
  if (typeof secrets !== 'object' || secrets === null) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(secrets as Record<string, unknown>)) {
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

interface Imported {
  plain: string[]
  secrets: string[]
  secretsMissingValues: string[]
  /** Passthrough names this server's environment could not answer for. Named
   *  because they are dropped outright — the file is stripped either way, so
   *  silence here is a setting that simply disappears. */
  passthroughMissingValues: string[]
}

async function importOne(
  slug: string,
  legacySecrets: Record<string, string>,
): Promise<Imported | null> {
  const file = path.join(projectConfigDir(slug), 'yaac-config.json')
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A file too broken to parse is a file the user has to fix by hand; the
    // config editor still opens it (it reads raw bytes), and rewriting it
    // here would destroy whatever they were mid-way through writing.
    serverLog(`[legacy] ${slug}: yaac-config.json does not parse; leaving it for the editor`)
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  const hasEnvKeys = ['env', 'envPassthrough', 'envSecretProxy']
    .some((k) => obj[k] !== undefined)
  if (!hasEnvKeys) return null

  // Rows already present win: a re-run must never overwrite a value the user
  // has since typed into the settings page with the stale one in the file.
  const existing = new Set((await listProjectEnvVars(slug)).map((r) => r.name))
  const result: Imported = {
    plain: [], secrets: [], secretsMissingValues: [], passthroughMissingValues: [],
  }

  // Passthrough first, then literals — the create path applied them in that
  // order and let a literal win on a name collision, so importing in the same
  // order through an upsert reproduces exactly what the worktrees had.
  if (Array.isArray(obj.envPassthrough)) {
    for (const name of obj.envPassthrough) {
      if (typeof name !== 'string' || existing.has(name)) continue
      const value = hostEnv(name)
      if (value === undefined) {
        result.passthroughMissingValues.push(name)
        continue
      }
      await upsertProjectEnvVar(slug, { name, value, secret: false })
      result.plain.push(name)
    }
  }
  if (typeof obj.env === 'object' && obj.env !== null && !Array.isArray(obj.env)) {
    for (const [name, value] of Object.entries(obj.env as Record<string, unknown>)) {
      if (typeof value !== 'string' || existing.has(name)) continue
      await upsertProjectEnvVar(slug, { name, value, secret: false })
      result.plain.push(name)
    }
  }
  if (typeof obj.envSecretProxy === 'object' && obj.envSecretProxy !== null
    && !Array.isArray(obj.envSecretProxy)) {
    for (const [name, raw2] of Object.entries(obj.envSecretProxy as Record<string, unknown>)) {
      if (existing.has(name)) continue
      let rule: SecretProxyRule
      try {
        rule = parseSecretProxyRule(name, raw2)
      } catch (err) {
        serverLog(
          `[legacy] ${slug}: skipping secret ${name} — its rule is invalid `
          + `(${err instanceof Error ? err.message : String(err)})`,
        )
        continue
      }
      // The file first: it is what the proxy actually resolved against, and
      // under `k8s` the process environment answers for nothing.
      const value = legacySecrets[name] ?? hostEnv(name)
      await upsertProjectEnvVar(slug, {
        name,
        secret: true,
        rule,
        value: value ?? '',
      })
      if (value === undefined) result.secretsMissingValues.push(name)
      else result.secrets.push(name)
    }
  }

  // tmp + rename, like `writeMarker` and the key file: this rewrites a file
  // the user owns and whose other keys (initCommands, cacheVolumes,
  // portForward) this pass has no opinion about. A torn write would leave an
  // overlay that does not parse, which the next start reports and leaves for
  // the editor — losing settings that had nothing to do with the import.
  const { env: _e, envPassthrough: _p, envSecretProxy: _s, ...rest } = obj
  const tmp = `${file}.${process.pid.toString()}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(rest, null, 2)}\n`)
  await fs.rename(tmp, file)
  return result
}

/** Run the import across every project. Never throws: a failed import is a
 *  project whose settings need re-entering, not a server that will not start. */
export async function importLegacyProjectConfig(): Promise<void> {
  let projects: Awaited<ReturnType<typeof listProjectRows>>
  try {
    projects = await listProjectRows()
  } catch (err) {
    serverLog(`[legacy] could not list projects for the env import: ${String(err)}`)
    return
  }
  // Read once, before any project is touched, and reused for all of them:
  // the file is a merged map across projects, and the delete below is what
  // finally removes it.
  const legacySecrets = await readLegacyProxySecrets()

  for (const { slug } of projects) {
    try {
      const imported = await importOne(slug, legacySecrets)
      if (!imported) continue
      const moved = [...imported.plain, ...imported.secrets]
      serverLog(
        `[legacy] ${slug}: moved ${String(moved.length)} environment `
        + 'setting(s) out of yaac-config.json into project settings'
        + (moved.length > 0 ? ` (${moved.join(', ')})` : ''),
      )
      if (imported.secretsMissingValues.length > 0) {
        serverLog(
          `[legacy] ${slug}: ${imported.secretsMissingValues.join(', ')} `
          + 'could not be recovered — set them under Settings → Project Config '
          + '→ Environment',
        )
      }
      // Named for the same reason the secrets above are: the key is stripped
      // from the file either way, so a name dropped in silence is a setting
      // that simply disappears — and under `k8s`, where the server pod's
      // environment holds only what its Deployment states, that is every one.
      if (imported.passthroughMissingValues.length > 0) {
        serverLog(
          `[legacy] ${slug}: ${imported.passthroughMissingValues.join(', ')} `
          + "had no value in this server's environment and were dropped — add "
          + 'them under Settings → Project Config → Environment if worktrees '
          + 'still need them',
        )
      }
    } catch (err) {
      serverLog(`[legacy] ${slug}: env import failed: ${String(err)}`)
    }
  }
}


/**
 * Whether any project's overlay still carries a retired `envSecretProxy`
 * key — i.e. whether {@link importLegacyProjectConfig} still has secrets to
 * move out of one.
 *
 * Asked by the runtime that owns when the old plaintext secrets file may be
 * deleted, because a config too broken to parse is SKIPPED by the import: a
 * start can complete having imported nothing from it, and sweeping then
 * would take the values that config's names still refer to. `true` on any
 * doubt, since the cost of waiting is a file that lingers one more restart
 * and the cost of not waiting is a secret nobody can recover.
 */
export async function legacySecretImportPending(): Promise<boolean> {
  let projects: Awaited<ReturnType<typeof listProjectRows>>
  try {
    projects = await listProjectRows()
  } catch {
    return true
  }
  for (const { slug } of projects) {
    const file = path.join(projectConfigDir(slug), 'yaac-config.json')
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    // An overlay that does not parse is exactly the case this exists for:
    // the import skipped it, so whatever it names has not been moved.
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        && (parsed as Record<string, unknown>).envSecretProxy !== undefined) {
        return true
      }
    } catch {
      return true
    }
  }
  return false
}
