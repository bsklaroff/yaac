import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as hostModule from '#drivers/containerless/host'

const mockRunHost = vi.hoisted(() => vi.fn())
const mockOnPath = vi.hoisted(() => vi.fn())
vi.mock('#drivers/containerless/host', async (importOriginal) => ({
  ...(await importOriginal<typeof hostModule>()),
  runHost: mockRunHost,
  onPath: mockOnPath,
}))
import { startContainerlessDriver, stopContainerlessDriver } from '#drivers/containerless/lifecycle'
import { setDataDir } from '@yaac/shared/paths'
import { AGENT_PACKAGES, agentPackagePrefix } from '@yaac/shared/tool-install'

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-cl-lifecycle-'))
  setDataDir(dataDir)
  mockOnPath.mockReset()
  mockOnPath.mockResolvedValue(true)
  mockRunHost.mockReset()
})

afterEach(() => {
  stopContainerlessDriver()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const sinks = {
  trigger: () => {},
  workspacesChanged: () => {},
  recover: () => Promise.resolve(),
  attached: () => {},
}

/** An install of `binary`'s package at `version`, as an earlier create
 *  would have left it. */
function installed(binary: string, version: string): void {
  const pkg = { ...AGENT_PACKAGES[binary], version }
  const bin = path.join(agentPackagePrefix(pkg), 'bin', binary)
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
}

describe('startContainerlessDriver', () => {
  it('installs the new pin of each agent this host used before, in the background', async () => {
    // npm puts the requested package's binaries in its `--prefix`.
    const npm: string[] = []
    mockRunHost.mockImplementation((argv: string[]) => {
      if (argv[0] !== 'npm') return Promise.resolve({ stdout: 'tmux 3.4\n', stderr: '' })
      const spec = argv.at(-1) ?? ''
      npm.push(spec)
      const prefix = argv[argv.indexOf('--prefix') + 1]
      fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true })
      for (const [binary, pkg] of Object.entries(AGENT_PACKAGES)) {
        if (`${pkg.package}@${pkg.version}` === spec) fs.writeFileSync(path.join(prefix, 'bin', binary), '', { mode: 0o755 })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    // claude was used at an older pin; pi already has the current one; codex
    // was never used here.
    installed('claude', '0.0.1')
    installed('pi', '0.0.1')
    installed('pi', AGENT_PACKAGES.pi.version)

    await startContainerlessDriver(sinks)

    const claude = AGENT_PACKAGES.claude
    await vi.waitFor(() => expect(fs.existsSync(path.join(agentPackagePrefix(claude), 'bin', 'claude'))).toBe(true))
    expect(npm).toEqual([`${claude.package}@${claude.version}`])
  })
})
