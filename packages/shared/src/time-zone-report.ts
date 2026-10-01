import { env } from './env'
import { getApiClient } from './server-api'

/**
 * Tell the server this machine's time zone, which it launches workspaces
 * with as `TZ`. A zone the user picked in settings outranks the report (the
 * route decides). Skipped inside a workspace, whose zone is the one the
 * server gave it, or UTC when it had none.
 */
export async function reportDeviceTimeZone(): Promise<void> {
  if (env.workspaceId !== undefined) return
  await getApiClient().config['time-zone'].$put({
    json: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  })
}
