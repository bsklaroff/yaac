import { readServerConfig } from '#server-config'
import type { DriverKind } from '#types'

/**
 * The substrate this data dir's install runs, as recorded in `server.json`
 * by `yaac server start` or `yaac cluster install` (`registerServer`).
 * Clients use it to decide how to bring up an unreachable server: start a
 * host process (containerless) or run `yaac cluster install` (k8s).
 */
export async function recordedDriver(): Promise<DriverKind | undefined> {
  return (await readServerConfig())?.driver
}
