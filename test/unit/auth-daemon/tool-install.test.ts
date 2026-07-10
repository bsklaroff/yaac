import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import type * as cliResolveModule from '@yaac/auth-daemon/cli-resolve'

// Both lookups hit the real machine (post-install verification, npm/brew
// discovery) — mocked so these tests pass regardless of what's installed
// locally.
const cliResolve = vi.hoisted(() => ({
  resolveToolCliPath: vi.fn<(tool: 'claude' | 'codex') => string | null>(() => '/fake/bin/tool'),
  resolveCommandPath: vi.fn<(name: string) => string | null>(() => null),
}))

vi.mock('@yaac/auth-daemon/cli-resolve', async (importOriginal) => {
  const actual = await importOriginal<typeof cliResolveModule>()
  return {
    ...actual,
    resolveToolCliPath: cliResolve.resolveToolCliPath,
    resolveCommandPath: cliResolve.resolveCommandPath,
  }
})

import {
  cancelToolInstall,
  clearAllToolInstallsForTests,
  getToolInstall,
  startToolInstall,
} from '@yaac/auth-daemon/tool-install'

const INSTALL_STUB = path.join(__dirname, '..', '..', 'helpers', 'fake-install-cli.cjs')

async function waitForStatus(id: string, status: string): Promise<void> {
  await vi.waitFor(() => {
    expect(getToolInstall(id).status).toBe(status)
  }, { timeout: 10_000, interval: 25 })
}

describe('tool install sessions', () => {
  beforeEach(() => {
    process.env.YAAC_E2E_CLAUDE_INSTALL_CLI = JSON.stringify([process.execPath, INSTALL_STUB])
    process.env.YAAC_E2E_CODEX_INSTALL_CLI = JSON.stringify([process.execPath, INSTALL_STUB])
    cliResolve.resolveToolCliPath.mockReset()
    cliResolve.resolveToolCliPath.mockReturnValue('/fake/bin/tool')
    cliResolve.resolveCommandPath.mockReset()
    cliResolve.resolveCommandPath.mockReturnValue(null)
  })

  afterEach(() => {
    clearAllToolInstallsForTests()
    delete process.env.YAAC_E2E_CLAUDE_INSTALL_CLI
    delete process.env.YAAC_E2E_CODEX_INSTALL_CLI
    delete process.env.FAKE_INSTALL_MODE
    delete process.env.FAKE_INSTALL_DELAY_MS
  })

  it('a completed install lands on success with the installer output', async () => {
    const started = startToolInstall('claude')
    expect(started.status).toBe('running')

    await waitForStatus(started.id, 'success')
    expect(getToolInstall(started.id).output).toContain('Installed.')
  })

  it('a failed installer surfaces its output tail as the error', async () => {
    process.env.FAKE_INSTALL_MODE = 'fail'
    const started = startToolInstall('codex')

    await waitForStatus(started.id, 'error')
    expect(getToolInstall(started.id).error).toContain('no network')
  })

  it('exit 0 is not enough — the CLI must resolve afterwards', async () => {
    cliResolve.resolveToolCliPath.mockReturnValue(null)
    const started = startToolInstall('claude')

    await waitForStatus(started.id, 'error')
    expect(getToolInstall(started.id).error).toContain('still cannot be found')
  })

  it('codex without npm or Homebrew errors with manual instructions', async () => {
    delete process.env.YAAC_E2E_CODEX_INSTALL_CLI
    const started = startToolInstall('codex')

    await waitForStatus(started.id, 'error')
    expect(getToolInstall(started.id).error).toContain('npm install -g @openai/codex')
  })

  it('unknown ids 404; cancel forgets the session and is idempotent', () => {
    expect(() => getToolInstall('nope')).toThrow(/No install session/)

    const started = startToolInstall('claude')
    cancelToolInstall(started.id)
    expect(() => getToolInstall(started.id)).toThrow(/No install session/)
    cancelToolInstall(started.id) // already gone — a no-op
  })

  it('restarting a tool install cancels the previous flow', async () => {
    process.env.FAKE_INSTALL_DELAY_MS = '5000' // keep the first flow alive
    const first = startToolInstall('claude')
    process.env.FAKE_INSTALL_DELAY_MS = '50'
    const second = startToolInstall('claude')
    expect(() => getToolInstall(first.id)).toThrow(/No install session/)
    await waitForStatus(second.id, 'success')
  })
})
