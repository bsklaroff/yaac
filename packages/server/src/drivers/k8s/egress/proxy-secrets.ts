import fs from 'node:fs/promises'
import { credentialsDir, ensureDataDir, proxySecretsCredentialsPath } from '@yaac/shared/project-paths'

/**
 * The proxy-secrets file: where the values behind a registration's
 * `secretRef` rules are put so the proxy can resolve them per request.
 *
 * This is delivery, not storage. WHICH env vars a project exposes and what
 * each is worth are decided above the runtime and arrive already resolved
 * (`SubstrateIntent.proxySecrets`); all that happens here is putting them
 * where the proxy looks, which is as much part of the egress datapath as
 * the registration itself. It sits beside `blocked-hosts` and
 * `git-auth-failures` for that reason — the same file-shaped channel
 * between server and proxy, running the other way.
 */

async function ensureCredentialsDir(): Promise<void> {
  await ensureDataDir()
  await fs.mkdir(credentialsDir(), { recursive: true, mode: 0o700 })
}

/**
 * Merge secret values into the proxy-secrets file. Must complete before the
 * registration that references them — otherwise the proxy drops those
 * injections as unresolvable until the file lands.
 *
 * Merge semantics, not replace: projects proxy different env vars and must
 * not clobber each other's entries.
 *
 * Written in place (the same convention as the git credentials file), NOT
 * via tmp+rename: a host-side rename swaps the directory entry to a new
 * inode, and the kind VM's virtiofs cache can miss that — a freshly
 * replaced proxy pod then sees ENOENT for the file. In-place writes keep the
 * inode stable. The proxy tolerates the resulting torn-read window exactly
 * as it does for github.json: an unparseable file drops the injection for
 * that one request and the next read sees settled bytes.
 */
export async function writeProxySecrets(secrets: Record<string, string>): Promise<void> {
  if (Object.keys(secrets).length === 0) return
  await ensureCredentialsDir()
  const file = proxySecretsCredentialsPath()
  const existing: Record<string, string> = {}
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      const prior = (parsed as Record<string, unknown>).secrets
      if (prior && typeof prior === 'object') {
        for (const [key, value] of Object.entries(prior as Record<string, unknown>)) {
          if (typeof value === 'string' && value) existing[key] = value
        }
      }
    }
  } catch {
    // first write or unreadable — start fresh
  }
  const payload = {
    savedAt: new Date().toISOString(),
    secrets: { ...existing, ...secrets },
  }
  await fs.writeFile(file, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
}
