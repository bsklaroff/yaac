import { afterEach, describe, expect, it } from 'vitest'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import { workspacesSandboxed } from '#drivers/driver'

afterEach(() => {
  resetWorkspaceDriver()
})

describe('workspacesSandboxed', () => {
  it('is false only for the containerless runtime', () => {
    installFakeWorkspaceDriver({ kind: 'containerless' })
    expect(workspacesSandboxed()).toBe(false)
    installFakeWorkspaceDriver({ kind: 'k8s' })
    expect(workspacesSandboxed()).toBe(true)
  })
})
