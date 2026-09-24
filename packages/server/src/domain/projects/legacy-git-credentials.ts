import fs from 'node:fs/promises'
import { githubCredentialsPath } from '@yaac/shared/project-paths'
import {
  deleteLegacyGitSshKeys,
  getGitCredential,
  getGitCredentialByName,
  importLegacyGitSshKeys,
  insertGitCredential,
  listProjectRows,
  setProjectGitCredential,
} from '#db'
import { serverLog } from '#log'
import { parseGitRemote } from './credentials'

/**
 * Turn an older install's pattern-matched git credentials into named ones,
 * and assign each project the one its pattern resolved to — so an upgrade
 * keeps every project authenticating as it did (docs/legacy-compat-shims.md,
 * "Pattern-matched git credentials").
 *
 * What it reads: the https tokens in `.credentials/github.json` and the
 * per-pattern keys in the `git_ssh_keys` table, each `{ pattern, secret }`.
 * The first match wins, as it did: tokens in file order, keys oldest first,
 * skipping a key whose seed no longer opens as the old lookup did. A
 * project that already has a credential is left alone.
 *
 * Runs on every start and is a no-op once both sources are empty — it
 * deletes the file and empties the table after the assignments land. A
 * crash in between re-runs harmlessly: a credential is looked up by its
 * name before one is inserted. A file that does not parse is left where it
 * is, since it holds plaintext tokens the user can still fix: the next
 * start imports it then, and assigns the projects still without one.
 */
export async function importLegacyGitCredentials(): Promise<void> {
  const tokens = await readLegacyTokens()
  const keys = await importLegacyGitSshKeys()
  if (tokens === null && keys.length === 0) return
  const usableKeys = []
  for (const k of keys) {
    if (await (await getGitCredential(k.id))?.openSecret() !== undefined) usableKeys.push(k)
  }

  const https: Array<{ id: string; pattern: string; knownHostsEntry: null }> = []
  for (const t of tokens ?? []) {
    const name = `${t.pattern} (token)`
    const id = (await getGitCredentialByName(name))?.id
      ?? (await insertGitCredential({ name, kind: 'https', secret: t.token })).id
    https.push({ id, pattern: t.pattern, knownHostsEntry: null })
  }

  let assigned = 0
  for (const row of await listProjectRows()) {
    if (row.gitCredentialId !== null) continue
    let remote
    try {
      remote = parseGitRemote(row.remoteUrl)
    } catch {
      continue
    }
    const { host, path } = remote
    const match = (remote.scheme === 'https' ? https : usableKeys)
      .find((c) => matchPattern(c.pattern, host, path))
    if (!match) continue
    await setProjectGitCredential(row.slug, match.id, match.knownHostsEntry)
    assigned++
  }

  await deleteLegacyGitSshKeys()
  if (tokens !== null) await fs.rm(githubCredentialsPath(), { force: true })
  serverLog(`[legacy] imported ${String(https.length + keys.length)} git credential(s) and `
    + `assigned ${String(assigned)} project(s) the one its pattern matched`)
}

/** The file's tokens; null when there is none, or none that parses. */
async function readLegacyTokens(): Promise<Array<{ pattern: string; token: string }> | null> {
  let raw: string
  try {
    raw = await fs.readFile(githubCredentialsPath(), 'utf8')
  } catch {
    return null
  }
  const out: Array<{ pattern: string; token: string }> = []
  try {
    const parsed = JSON.parse(raw) as { tokens?: unknown }
    for (const t of Array.isArray(parsed.tokens) ? parsed.tokens as unknown[] : []) {
      const e = t as Record<string, unknown> | null
      if (e?.kind !== undefined && e.kind !== 'https') continue
      if (typeof e?.pattern !== 'string' || typeof e.token !== 'string' || !e.token) continue
      out.push({ pattern: e.pattern, token: e.token })
    }
  } catch {
    serverLog('[legacy] .credentials/github.json is not valid JSON; leaving it in place, '
      + 'unimported — fix it and restart the server to import its tokens')
    return null
  }
  return out
}

/**
 * The pattern grammar the credentials were matched with: `<host>/*`,
 * `<host>/<path>` or `<host>/<prefix>/*`. Anything else matches nothing.
 */
function matchPattern(pattern: string, host: string, path: string): boolean {
  const [patternHost, ...rest] = pattern.split('/')
  if (patternHost !== host || rest.length === 0 || rest.some((p) => !p)) return false
  if (rest.length === 1 && rest[0] === '*') return true
  if (rest[rest.length - 1] === '*') {
    const prefix = rest.slice(0, -1).join('/')
    return path === prefix || path.startsWith(prefix + '/')
  }
  return path === rest.join('/')
}
