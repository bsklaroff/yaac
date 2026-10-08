/**
 * Entry of the auth daemon's utilityProcess (server-process.ts), bundled
 * beside the main process as dist/auth-daemon.js. Its one argument is the
 * origin of the server it serves.
 */
import { runAuthDaemon } from '@yaac/auth-daemon/run'

const baseUrl = process.argv[2]
if (!baseUrl) {
  console.error('[auth-daemon] usage: auth-daemon <server origin>')
  process.exit(2)
}
runAuthDaemon(baseUrl).catch((err: unknown) => {
  console.error(`[auth-daemon] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
