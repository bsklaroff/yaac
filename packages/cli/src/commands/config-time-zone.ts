import { api } from '#commands/api'

/**
 * `yaac config time-zone [zone] [--follow-device]`: show the time zone new
 * workspaces launch in and chats show times in, or pin it to an IANA zone.
 * Unpinned it follows whichever device last connected; `--follow-device`
 * unpins it, starting from this machine's zone, as the webapp's Automatic
 * does.
 */
export async function configTimeZone(zone: string | undefined, opts: { followDevice?: boolean }): Promise<void> {
  const route = api.config['time-zone']
  const describe = ({ timeZone, pinned }: { timeZone: string | null; pinned: boolean }): string =>
    timeZone === null ? 'not known yet; no device has reported one' : `${timeZone}${pinned ? '' : ', following your devices'}`

  if (zone === undefined && opts.followDevice !== true) {
    console.log(`Time zone: ${describe(await route.$get())}`)
    return
  }
  if (zone !== undefined && opts.followDevice === true) throw new Error('Pass a zone or --follow-device, not both.')
  const stored = await route.$put({
    json: zone !== undefined
      ? { timeZone: zone, pinned: true }
      : { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, pinned: false },
  })
  console.log(`Time zone is now ${describe(stored)}. Workspaces started from now on launch in it.`)
}
