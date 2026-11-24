import fs from 'node:fs/promises'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

/**
 * File order for the k8s `e2e` project, which runs two workers. A file that
 * spawns a server holds the cross-worker server mutex (`#support/cli`) for
 * as long as that server runs, so only one of them runs at a time, while a
 * file that drives the cluster without a server can run beside it. The
 * longest server-backed file goes first and every server-less file next,
 * so the second worker works through those rather than wait on the mutex.
 * A server-less file that takes the node lock exclusive (`#support/node-lock`)
 * waits for whatever the other worker runs, so it goes after the other
 * server-less ones, where the second worker has nothing left to run beside.
 * Other projects keep vitest's own order.
 */
export default class E2eSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files)
    const e2e = sorted.filter((f) => f.project.name === 'e2e')
    if (e2e.length === 0) return sorted
    const source = new Map(await Promise.all(e2e.map(async (f) => [f, await fs.readFile(f.moduleId, 'utf8')] as const)))
    const servers = e2e.filter((f) => source.get(f)!.includes('spawnYaacServer('))
    const serverless = e2e.filter((f) => !servers.includes(f))
    const exclusive = (f: TestSpecification): boolean => source.get(f)!.includes('acquireNodeExclusive(')
    return [
      ...sorted.filter((f) => f.project.name !== 'e2e'),
      ...servers.slice(0, 1),
      ...serverless.filter((f) => !exclusive(f)),
      ...serverless.filter(exclusive),
      ...servers.slice(1),
    ]
  }
}
