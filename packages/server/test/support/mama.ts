import { createApiClient } from '@yaac/shared/api-core'
import type { WorkspaceDelegate } from '@yaac/shared/types'
import { mamaCaller, type MamaCaller } from '#api/mama/commands'
import { mamaDispatch } from '#main/server'

const dispatch = mamaDispatch({ buildId: 'test' })

/** A `yaac-mama` caller acting as `delegate`, whose commands reach the
 *  real routes through `delegateApp`, as the endpoint's do. */
export function callerAs(delegate: WorkspaceDelegate): MamaCaller {
  return mamaCaller(delegate, createApiClient('http://yaac-mama', dispatch(delegate)))
}
