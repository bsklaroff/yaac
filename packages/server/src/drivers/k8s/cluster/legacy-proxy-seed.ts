import fs from 'node:fs/promises'
import path from 'node:path'
import {
  PROXY_CA_SECRET_NAME,
  PROXY_STATE_CONFIGMAP_NAME,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
} from '#drivers/k8s/substrate'
import { credentialsDir, sharedPath } from '@yaac/shared/project-paths'
import { serverLog } from '#log'
import { buildProxyOutputManifests, buildRegistrationConfigMapManifest } from './proxy-manifests'

/**
 * Two legacy-compat shims around the proxy's move onto objects
 * (docs/legacy-compat-shims.md).
 *
 * `seedProxyObjects` carries what an older proxy kept on its hostPath —
 * the CA, every live worktree's registration, the blocked-host and
 * git-auth records — into the objects the new proxy reads, so the first
 * roll onto the new image keeps the same CA and every running worktree
 * registered. `sweepLegacyProxySecretsFile` deletes the plaintext secrets
 * file an older-still proxy read, once nothing can be reading it.
 */

/** Where the old proxy's `/data` hostPath lived, off the data dir the
 *  server mounts. Read here and nowhere else; never deleted. */
function legacyProxyDataDir(): string {
  return sharedPath('run', 'proxy-data')
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      serverLog(`[legacy] could not read ${file}: ${String(err)}`)
    }
    return null
  }
}

/**
 * One of the proxy's pre-created outputs, with `data` filled in — the
 * same metadata `ensureProxyResources` applied, so an apply here keeps
 * the labels the server's informers select on rather than deleting them
 * through the three-way merge.
 */
function outputManifest(name: string, data: Record<string, string>): Record<string, unknown> {
  const manifest = buildProxyOutputManifests()
    .find((m) => (m as { metadata: { name: string } }).metadata.name === name)
  if (!manifest) throw new Error(`no pre-created proxy output named ${name}`)
  return { ...manifest, data }
}

interface LegacyInjection { secretRef?: string }
interface LegacyRule { injections: LegacyInjection[] }

/**
 * Give a persisted registration's bare `secretRef`s their project scope.
 *
 * A ref used to be the variable NAME alone, resolved against one flat map
 * shared by every project; it is `<projectSlug>/<NAME>` now. A registration
 * written before that names refs the server will never push again, and
 * its injections would stop resolving silently until the worktree was
 * recreated. The rewrite is exact rather than a guess: a registration
 * carries the project it belongs to, and a bare ref in it could only ever
 * have meant that project's secret of that name.
 */
export function scopeLegacySecretRefs<R extends LegacyRule>(rules: R[], projectSlug: string | undefined): R[] {
  if (projectSlug === undefined || projectSlug === '') return rules
  return rules.map((rule) => ({
    ...rule,
    injections: rule.injections.map((inj) =>
      inj.secretRef !== undefined && !inj.secretRef.includes('/')
        ? { ...inj, secretRef: `${projectSlug}/${inj.secretRef}` }
        : inj),
  }))
}

/**
 * Seed the proxy's output objects from the old hostPath directory — once,
 * the first time the CA Secret is found empty beside an old `ca.pem`.
 *
 * What a wrong answer costs is why this exists: a proxy rolling onto an
 * empty CA Secret mints a new CA, and every process that loaded the old
 * one (running agents, nested containers' baked bundles) fails TLS until
 * its pod restarts; and it comes up with no registrations, failing every
 * running worktree closed — nothing re-registers a live worktree.
 */
export async function seedProxyObjects(): Promise<void> {
  const ns = k8sNamespace()
  const ca = await kubectlGetJson<{ data?: Record<string, string> }>([
    'get', 'secret', PROXY_CA_SECRET_NAME, '-n', ns,
  ])
  if (ca?.data?.['ca.pem']) return
  const dir = legacyProxyDataDir()
  let keyPem: string
  let certPem: string
  try {
    ;[keyPem, certPem] = await Promise.all([
      fs.readFile(path.join(dir, 'ca.key'), 'utf8'),
      fs.readFile(path.join(dir, 'ca.pem'), 'utf8'),
    ])
  } catch (err) {
    // A fresh install has no old directory. Anything else is worth a line:
    // a proxy that rolls onto an empty CA Secret mints a new CA, which is
    // exactly the silent failure this shim exists to prevent.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      serverLog(`[legacy] could not read the old proxy CA under ${dir}: ${String(err)}`)
    }
    return
  }

  // The registrations and records first, the CA last: the CA is what
  // marks the seed done, so a failure before it leaves the next run to
  // seed everything again rather than a live worktree un-seeded.
  let registrations = 0
  const worktrees = await readJson(path.join(dir, 'worktrees.json'))
  if (worktrees && typeof worktrees === 'object') {
    for (const [worktreeId, raw] of Object.entries(worktrees as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue
      const reg = raw as { rules?: unknown; allowedHosts?: unknown; projectSlug?: unknown; tool?: unknown }
      if (!Array.isArray(reg.rules) || !Array.isArray(reg.allowedHosts)) continue
      if (typeof reg.projectSlug !== 'string' || typeof reg.tool !== 'string') continue
      await kubectlApply(buildRegistrationConfigMapManifest(worktreeId, reg.projectSlug, {
        ...reg,
        rules: scopeLegacySecretRefs(reg.rules as LegacyRule[], reg.projectSlug),
      }))
      registrations++
    }
  }

  const blocked = await readJson(path.join(dir, 'blocked-hosts.json'))
  const failures = await readJson(path.join(dir, 'git-auth-failures.json'))
  await kubectlApply(outputManifest(PROXY_STATE_CONFIGMAP_NAME, {
    'blocked-hosts.json': JSON.stringify(blocked ?? {}),
    'git-auth-failures.json': JSON.stringify(failures ?? {}),
  }))
  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
  await kubectlApply(outputManifest(PROXY_CA_SECRET_NAME, { 'ca.key': b64(keyPem), 'ca.pem': b64(certPem) }))
  serverLog(`[legacy] seeded the proxy's objects from ${dir}: ${String(registrations)} registration(s), its records, the CA`)
}

/**
 * Remove the file an older proxy read secret values from, once one that
 * does not need it is answering.
 *
 * The file is a plaintext copy of every secret this install ever proxied,
 * so it wants deleting — but not on the server's say-so alone: the caller
 * runs this after the new Deployment's rollout has completed (the old
 * proxy, the last reader, is gone) and only when no project overlay still
 * carries an `envSecretProxy` key waiting to be imported OUT of it.
 */
export async function sweepLegacyProxySecretsFile(): Promise<void> {
  const file = path.join(credentialsDir(), 'proxy-secrets.json')
  try {
    await fs.rm(file, { force: true })
  } catch (err) {
    serverLog(
      '[legacy] could not remove the old proxy-secrets file: '
      + (err instanceof Error ? err.message : String(err)),
    )
  }
}
