import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { setDataDir } from '@yaac/shared/paths'
import { acpLogDir, workspaceDir } from '@yaac/shared/project-paths'
import {
  assertShellSafePaths,
  assertSocketPathsFit,
  containerlessJobName,
  containerlessWorkspacePaths,
  refFromJobName,
  containerlessStateDir,
} from '#drivers/containerless/paths'

const UUID = '4bfc59c6-1e83-4dd0-80f1-735294d5d2bb'

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-cl-paths-'))
  setDataDir(dataDir)
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('containerlessJobName', () => {
  it('encodes both halves of the identity so a handle alone can be resolved', () => {
    const jobName = containerlessJobName('demo', UUID)
    expect(refFromJobName(jobName)).toEqual({ projectId: 'demo', workspaceId: UUID })
  })

  it('survives a projectId carrying the same separator it joins with', () => {
    // The id is a fixed-width tail, so a dashed project id is not split wrongly.
    const jobName = containerlessJobName('my-cool-repo', UUID)
    expect(refFromJobName(jobName))
      .toEqual({ projectId: 'my-cool-repo', workspaceId: UUID })
  })
})

describe('refFromJobName', () => {
  it('refuses a handle this driver did not mint rather than inventing an identity', () => {
    // A guessed identity could send a teardown to another workspace's socket.
    expect(() => refFromJobName('yaac-demo-' + UUID)).toThrow(/not a containerless/)
    expect(() => refFromJobName('cl-short')).toThrow(/not a containerless/)
  })
})

describe('containerlessWorkspacePaths', () => {
  it('points the workspace at the checkout the server already made', () => {
    const paths = containerlessWorkspacePaths(containerlessJobName('demo', UUID))
    // No path translation: the agent works in the host checkout.
    expect(paths.workspaceDir).toBe(workspaceDir('demo', UUID))
  })

  it('gives each workspace its own tmux socket', () => {
    const a = containerlessWorkspacePaths(containerlessJobName('demo', UUID))
    const b = containerlessWorkspacePaths(
      containerlessJobName('demo', '00000000-0000-4000-8000-000000000000'),
    )
    // A shared socket would mean a shared tmux server, where
    // `has-session -t yaac` answers for whichever workspace started first.
    expect(a.tmuxSock).not.toBe(b.tmuxSock)
    expect(a.tmuxSock.startsWith(os.tmpdir())).toBe(true)
  })

  it('fits sun_path even on a macOS per-user TMPDIR', () => {
    // Linux CI would not catch this: macOS TMPDIR is
    // `/var/folders/XX/<~30 chars>/T`, about 48 bytes, so a full 36-char UUID
    // in the socket name alone would exceed the 104-byte limit.
    const macTmp = '/var/folders/qz/8n1x2j5d7g93_kkr0vlp4jhm0000gn/T'
    expect(macTmp.length).toBeGreaterThan(45)
    const paths = containerlessWorkspacePaths(containerlessJobName('demo', UUID))
    const rebased = (p: string): string => path.join(macTmp, path.relative(os.tmpdir(), p))
    // The acpd socket is the longest path under the dir.
    const longest = path.join(rebased(paths.acpSockDir), 'opencode-2.sock')
    expect(Buffer.byteLength(longest)).toBeLessThan(104)
    expect(Buffer.byteLength(rebased(paths.tmuxSock))).toBeLessThan(104)
  })

  it('refuses a path that could not survive a workspace\'s command text', () => {
    // Command builders do not quote paths (under k8s they are constants).
    // Here they derive from the data dir, so a space must be refused rather
    // than silently `cd` somewhere else.
    const paths = containerlessWorkspacePaths(containerlessJobName('demo', UUID))
    expect(() => assertShellSafePaths(paths)).not.toThrow()
    expect(() => assertShellSafePaths({ ...paths, workspaceDir: '/My Drive/yaac/wt' }))
      .toThrow(/cannot be carried into a workspace's shell commands/)
    expect(() => assertShellSafePaths({ ...paths, tmuxSock: '/tmp/a$(id).sock' }))
      .toThrow(/cannot be carried/)
  })

  it('refuses a launch whose sockets would not bind, rather than failing at tmux', () => {
    const paths = containerlessWorkspacePaths(containerlessJobName('demo', UUID))
    expect(() => assertSocketPathsFit(paths)).not.toThrow()
    expect(() => assertSocketPathsFit({ ...paths, tmuxSock: `/${'x'.repeat(200)}.sock` }))
      .toThrow(/exceeds the 104-byte limit/)
  })

  it('records ACP conversations where the layers above read them, and where a stop cannot reach', () => {
    // Conversation readers (the chat pane, first-prompt scan, stopped
    // transcripts) look in the shared project location. It must also
    // outlive the state dir, which is removed on stop.
    const paths = containerlessWorkspacePaths(containerlessJobName('demo', UUID))
    expect(paths.acpLogDir).toBe(acpLogDir('demo', UUID))
    expect(paths.acpLogDir.startsWith(containerlessStateDir('demo', UUID))).toBe(false)
  })

  it('answers identically for the same handle, without consulting anything', () => {
    // A probe of a gone workspace must still name its socket, so nothing
    // here may depend on live state.
    const jobName = containerlessJobName('demo', UUID)
    expect(containerlessWorkspacePaths(jobName)).toEqual(containerlessWorkspacePaths(jobName))
  })
})
