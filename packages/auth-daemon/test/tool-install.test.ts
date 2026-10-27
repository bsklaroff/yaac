import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type * as cliResolveModule from '#cli-resolve'

// Mocked so the tests don't depend on what is installed locally.
const cliResolve = vi.hoisted(() => ({
  resolveToolCliPath: vi.fn<(tool: 'claude' | 'codex') => string | null>(() => '/fake/bin/tool'),
}))

vi.mock('#cli-resolve', async (importOriginal) => {
  const actual = await importOriginal<typeof cliResolveModule>()
  return {
    ...actual,
    resolveToolCliPath: cliResolve.resolveToolCliPath,
  }
})

import {
  cancelToolInstall,
  killAllToolInstalls,
  getToolInstall,
  startToolInstall,
} from '#tool-install'
import { INSTALL_STUB } from '@yaac/test-utils/fixtures'
import { AGENT_CLIS } from '@yaac/shared/types'

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
  })

  afterEach(() => {
    killAllToolInstalls()
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

  describe('pinned downloads', () => {
    beforeEach(() => {
      delete process.env.YAAC_E2E_CLAUDE_INSTALL_CLI
      delete process.env.YAAC_E2E_CODEX_INSTALL_CLI
    })
    afterEach(() => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    // Stands in for the pinned asset: it reports how it was run, and as
    // claude's `install` it downloads a copy of itself.
    const script = [
      '#!/bin/sh',
      'echo "ran $* non-interactive=$CODEX_NON_INTERACTIVE"',
      'if [ "$1" = install ]; then',
      '  mkdir -p "$HOME/.local/share/claude/versions" && echo copy > "$HOME/.local/share/claude/versions/$2"',
      'fi',
      '',
    ].join('\n')

    function serve(body: string) {
      const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response(body)))
      vi.stubGlobal('fetch', fetchMock)
      return fetchMock
    }

    /** Make the next `times` SHA-256s come out as `sum()`. */
    function matchPin(sum: () => string | undefined, times = 1): void {
      const real = crypto.createHash.bind(crypto)
      const spy = vi.spyOn(crypto, 'createHash')
      for (let i = 0; i < times; i++) {
        spy.mockImplementationOnce(() => Object.assign(real('sha256'), { digest: sum }))
      }
    }

    it('runs the pinned codex release\'s script non-interactively when its SHA-256 matches', async () => {
      const { version, installScriptSha256 } = AGENT_CLIS.codex
      matchPin(() => installScriptSha256)
      const fetchMock = serve(script)
      const started = startToolInstall('codex')
      await waitForStatus(started.id, 'success')
      expect(fetchMock.mock.calls[0][0])
        .toBe(`https://github.com/openai/codex/releases/download/rust-v${version}/install.sh`)
      expect(getToolInstall(started.id).output).toContain(`ran --release ${version} non-interactive=1`)
    })

    it('runs the pinned claude binary\'s own install and keeps its copy only if that matches too', async () => {
      const { version, binarySha256 } = AGENT_CLIS.claude
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-claude-home-'))
      const installed = path.join(home, '.local', 'share', 'claude', 'versions', version)
      vi.stubEnv('HOME', home)
      try {
        const fetchMock = serve(script)
        // The URL names the platform build, whose pin the hash must match.
        const pin = (): string | undefined =>
          binarySha256[/\/([^/]+)\/claude$/.exec(fetchMock.mock.calls[0][0] as string)?.[1] ?? '']

        // The download and the copy `install` leaves both match.
        matchPin(pin, 2)
        const ok = startToolInstall('claude')
        await waitForStatus(ok.id, 'success')
        expect(fetchMock.mock.calls[0][0] as string)
          .toMatch(new RegExp(`^https://downloads\\.claude\\.ai/claude-code-releases/${version}/[a-z0-9-]+/claude$`))
        expect(getToolInstall(ok.id).output).toContain(`ran install ${version}`)
        expect(await fs.readFile(installed, 'utf8')).toBe('copy\n')

        // `install` downloads the version again, and a copy that does not
        // match the pin is deleted rather than left on PATH.
        matchPin(pin, 1)
        const bad = startToolInstall('claude')
        await waitForStatus(bad.id, 'error')
        expect(getToolInstall(bad.id).error).toContain('does not match its pinned SHA-256, so it was deleted')
        await expect(fs.access(installed)).rejects.toThrow()
      } finally {
        vi.unstubAllEnvs()
        await fs.rm(home, { recursive: true, force: true })
      }
    })

    it('refuses a download that does not match the pinned SHA-256', async () => {
      serve(script)
      for (const tool of ['claude', 'codex'] as const) {
        const started = startToolInstall(tool)
        await waitForStatus(started.id, 'error')
        expect(getToolInstall(started.id).error).toContain('does not match its pinned SHA-256')
        expect(getToolInstall(started.id).output).toBe('')
      }
    })
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
