import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { stepAdd, type StepAddOptions } from '#commands/workspace-steps'
import { startFakeApi, type FakeApi } from './fake-api'

/*
 * What `yaac workspace step add` refuses by itself, before it asks the
 * server for anything. The e2e suite runs one through the real CLI, and the
 * steps that do reach the server.
 */
let api: FakeApi

beforeAll(async () => {
  api = await startFakeApi()
  vi.stubEnv('YAAC_SERVER_URL', api.url)
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await api.close()
})

describe('stepAdd', () => {
  it('refuses a step it cannot make, asking the server nothing', async () => {
    const refused = async (options: Partial<StepAddOptions>, message: string): Promise<void> => {
      await expect(stepAdd('w1', { run: [], repo: [], ...options }), message).rejects.toThrow(message)
    }

    // A workflow's steps are added as they are.
    const stepOptions: Array<Partial<StepAddOptions>> = [
      { run: ['true'] }, { name: 'x' }, { needs: 'install' }, { service: true }, { ready: 'true' }, { repo: ['lib'] },
    ]
    for (const options of stepOptions) {
      await refused({ workflow: 'ci', ...options }, '--workflow adds that workflow\'s steps as they are; it takes no other step option.')
    }
    await refused({}, 'Give the step\'s commands with --run (repeat it for more), or --workflow.')
    await refused({ run: ['true'], ready: 'true' }, '--ready goes with --service: only a service has a ready check.')

    expect(api.requests).toEqual([])
  })
})
