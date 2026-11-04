import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { env } from '@yaac/shared/env'
import { readBuildId } from '@yaac/shared/build-id'
import { ServerError } from '@yaac/shared/errors'
import { feedbackKeyPath } from '@yaac/shared/project-paths'
import type { Principal } from '@yaac/shared/types'
import { getGitIdentity } from '#db'
import { workspaceDriver } from '#drivers/driver'
import { inlineImages } from '#lib/images'
import { serverLog } from '#lib/log'

/*
 * Feedback goes from the server rather than the browser so the webapp's
 * CSP stays `connect-src 'self'`, and so it can be signed with a key no
 * client holds. The wire contract the endpoint verifies is in
 * docs/feedback.md.
 */

/** How long the endpoint may take before the user is told it failed. */
const SEND_TIMEOUT_MS = 15_000

/** The feedback endpoint, or null when this server has none: the variable
 *  is unset, or is not a URL. */
function endpoint(): URL | null {
  const raw = env.feedbackUrl
  return raw !== undefined && URL.canParse(raw) ? new URL(raw) : null
}

/** Where this server sends feedback, as the form names it to the user;
 *  null when it has no endpoint, which hides the form. */
export function feedbackHost(): string | null {
  return endpoint()?.host ?? null
}

/**
 * Who the feedback is from: the caller's tailnet login and name, or else
 * the git identity their workspaces commit as. Null when a local caller
 * has no git identity yet.
 */
async function sender(principal: Principal): Promise<{ source: 'tailscale' | 'git'; email: string; name: string } | null> {
  if (principal.kind === 'tailnet') return { source: 'tailscale', email: principal.login, name: principal.name }
  const git = await getGitIdentity(principal.userId)
  return git && { source: 'git', ...git }
}

/** The key load in flight, which concurrent sends in this process share. */
let loading: Promise<crypto.KeyObject> | null = null

/**
 * The install's signing key. Concurrent sends share one load, and another
 * process racing a first send is settled by `loadKey`'s link.
 */
function signingKey(): Promise<crypto.KeyObject> {
  loading ??= loadKey().finally(() => { loading = null })
  return loading
}

/**
 * Read the key, generating it on first use or when the file does not
 * parse: losing it only gives the install a new identity at the endpoint.
 * A new key is written to a temp file and hard-linked into place, so a
 * crash can't leave a truncated key and a key already there is never
 * replaced.
 */
async function loadKey(): Promise<crypto.KeyObject> {
  const file = feedbackKeyPath()
  const read = async (): Promise<crypto.KeyObject | undefined> => {
    const pem = await fs.readFile(file, 'utf8').catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    })
    if (pem === undefined) return undefined
    try {
      return crypto.createPrivateKey(pem)
    } catch {
      serverLog(`[feedback] ${file} holds no key; replacing it, so the endpoint sees a new install`)
      await fs.rm(file, { force: true })
      return undefined
    }
  }
  const existing = await read()
  if (existing !== undefined) return existing
  const { privateKey } = crypto.generateKeyPairSync('ed25519')
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid.toString()}.tmp`
  await fs.writeFile(tmp, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  try {
    await fs.link(tmp, file).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    })
  } finally {
    await fs.rm(tmp, { force: true })
  }
  const key = await read()
  if (key === undefined) throw new Error(`${file} is unreadable after writing it`)
  return key
}

/** What the client says about itself: its build stamp, its user agent,
 *  and the native app around the webapp if there is one. Reported by the
 *  client, so not vouched for. */
interface FeedbackClient {
  version?: string | undefined
  gitCommit?: string | undefined
  userAgent: string
  app?: { kind: string; version?: string | undefined; build?: string | undefined; gitCommit?: string | undefined } | undefined
}

/**
 * Forward a report (its words, screenshots and the client it came from) to
 * `YAAC_FEEDBACK_URL` with this server's own build, signed with this
 * install's key, and answer the host it went to. Throws when there is no
 * endpoint, an image is refused (`inlineImages`), or the endpoint cannot
 * be reached or does not accept it. A redirect is a failure: the
 * configured URL is the one place the report may go.
 */
export async function submitFeedback(
  principal: Principal,
  report: { message: string; images?: unknown; client?: FeedbackClient | undefined },
): Promise<{ host: string }> {
  const url = endpoint()
  if (url === null) {
    throw new ServerError('NOT_SUPPORTED', 'This server has no feedback endpoint: YAAC_FEEDBACK_URL is unset or not a URL.')
  }
  const images = inlineImages(report.images)
  if (typeof images === 'string') throw new ServerError('VALIDATION', `feedback not sent: ${images}`)
  const key = await signingKey()
  const { client } = report
  const body = JSON.stringify({
    message: report.message,
    images: images.map(({ mimeType, data }) => ({ mimeType, data })),
    sentAt: new Date().toISOString(),
    from: await sender(principal),
    server: {
      version: env.version ?? null,
      gitCommit: env.gitCommit ?? null,
      buildId: await readBuildId(),
      driver: workspaceDriver().kind,
    },
    client: client
      ? {
          version: client.version ?? null,
          gitCommit: client.gitCommit ?? null,
          userAgent: client.userAgent,
          app: client.app
            ? {
                kind: client.app.kind,
                version: client.app.version ?? null,
                build: client.app.build ?? null,
                gitCommit: client.app.gitCommit ?? null,
              }
            : null,
        }
      : null,
  })
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-yaac-key': crypto.createPublicKey(key).export({ format: 'jwk' }).x ?? '',
      'x-yaac-signature': crypto.sign(null, Buffer.from(body), key).toString('base64url'),
    },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  }).catch((err: unknown) => {
    const why = err instanceof Error && err.name === 'TimeoutError'
      ? `no answer in ${(SEND_TIMEOUT_MS / 1000).toString()} s`
      : err instanceof Error && err.cause instanceof Error ? err.cause.message : String(err)
    throw new Error(`could not reach the feedback endpoint at ${url.host} (${why})`)
  })
  // Unread, the body would hold the connection until it is collected.
  await res.body?.cancel()
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`the feedback endpoint answered ${res.status.toString()}, a redirect, which feedback never follows`)
  }
  if (!res.ok) throw new Error(`the feedback endpoint answered ${res.status.toString()}`)
  return { host: url.host }
}
