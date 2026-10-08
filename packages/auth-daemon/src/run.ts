import { connectAuthAgent } from '#connection'
import { killAllToolLogins, setToolLoginPersistence } from '#tool-login'
import { killAllToolInstalls } from '#tool-install'
import { getApiClient } from '@yaac/shared/server-api'
import { buildAuthPayload } from '@yaac/shared/tool-auth-interactive'
import { seedGitIdentityFromShell } from '@yaac/shared/git-identity-seed'
import { reportDeviceTimeZone } from '@yaac/shared/time-zone-report'

/**
 * The auth daemon's entry, run by the desktop app as a child that lives
 * exactly as long as the app (packages/desktop/src/server-process.ts). It
 * only makes outbound connections: one WebSocket to the server at `baseUrl`,
 * and the local vendor login/install subprocesses. Captured credentials are
 * sent with the authenticated `PUT /auth/:tool` call, never over the relay
 * socket.
 *
 * Every call goes to `baseUrl`, never to whatever `server.json` selects by
 * then, so a sign-in relayed by one server can never be saved on another.
 */

function log(line: string): void {
  console.log(`[auth-daemon] ${line}`)
}

export async function runAuthDaemon(baseUrl: string): Promise<void> {
  // No version check: the desktop app's build id may differ from the
  // server's.
  const client = getApiClient({ resolveTarget: () => Promise.resolve({ baseUrl }), warnOnBuildSkew: false })

  // Completed logins are saved on the (possibly remote) server.
  setToolLoginPersistence(async (tool, result) => {
    await client.auth[':tool'].$put({
      param: { tool },
      json: buildAuthPayload(tool, result),
    })
  })

  // Seed the server's git identity from this machine's git config, so
  // webapp-only users get one too. Never overwrites an existing identity,
  // and failure is not fatal.
  try {
    const identity = await seedGitIdentityFromShell(client)
    if (identity) log(`git identity: ${identity.name} <${identity.email}>`)
  } catch (err) {
    log(`could not seed the git identity: ${err instanceof Error ? err.message : String(err)}`)
  }
  await reportDeviceTimeZone(client).catch((err: unknown) => {
    log(`could not report the time zone: ${err instanceof Error ? err.message : String(err)}`)
  })

  log(`target=${baseUrl}`)
  const connection = connectAuthAgent({ baseUrl, log })

  const shutdown = (signal: string): void => {
    log(`${signal} — shutting down`)
    connection.stop()
    // Kill in-flight vendor CLIs so they don't outlive the daemon.
    killAllToolLogins()
    killAllToolInstalls()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}
