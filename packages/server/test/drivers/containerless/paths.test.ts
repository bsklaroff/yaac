import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { setDataDir } from '@yaac/shared/paths'
import { acpLogDir, worktreeDir } from '@yaac/shared/project-paths'
import {
  assertShellSafePaths,
  assertSocketPathsFit,
  containerlessJobName,
  containerlessWorkspacePaths,
  refFromJobName,
  workspaceStateDir,
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
    expect(refFromJobName(jobName)).toEqual({ projectSlug: 'demo', worktreeId: UUID })
  })

  it('survives a slug carrying the same separator it joins with', () => {
    // The id is a fixed-width tail, so the slug is whatever precedes it —
    // which is what keeps a dashed slug from being split in the wrong place.
    const jobName = containerlessJobName('my-cool-repo', UUID)
    expect(refFromJobName(jobName))
      .toEqual({ projectSlug: 'my-cool-repo', worktreeId: UUID })
  })
})

describe('refFromJobName', () => {
  it('refuses a handle this driver did not mint rather than inventing an identity', () => {
    // A wrong answer here would send a teardown at some other worktree's
    // socket, so it must not be guessable.
    expect(() => refFromJobName('yaac-demo-' + UUID)).toThrow(/not a containerless/)
    expect(() => refFromJobName('cl-short')).toThrow(/not a containerless/)
  })
})

describe('containerlessWorkspacePaths', () => {
  it('points the workspace at the checkout the server already made', () => {
    const paths = containerlessWorkspacePaths(containerlessJobName('demo', UUID))
    // No path translation: what the agent sees IS the host checkout, which
    // is why the create path skips the in-pod gitdir rewrite entirely.
    expect(paths.workspaceDir).toBe(worktreeDir('demo', UUID))
    expect(paths.repoGitDir).toBe(path.join(dataDir, 'projects', 'demo', 'repo', '.git'))
  })

  it('gives each worktree its own tmux socket', () => {
    const a = containerlessWorkspacePaths(containerlessJobName('demo', UUID))
    const b = containerlessWorkspacePaths(
      containerlessJobName('demo', '00000000-0000-4000-8000-000000000000'),
    )
    // Two worktrees sharing one socket would share one tmux server, where
    // `has-session -t yaac` answers for whichever got there first.
    expect(a.tmuxSock).not.toBe(b.tmuxSock)
    expect(a.tmuxSock.startsWith(os.tmpdir())).toBe(true)
  })

  it('fits sun_path even on a macOS per-user TMPDIR', () => {
    // The real constraint, and the one Linux CI would never catch: macOS
    // hands each user a `/var/folders/XX/<~30 chars>/T`, which is ~48 bytes
    // before yaac writes anything — a full 36-char UUID in the socket name
    // clears the 104-byte limit on its own.
    const macTmp = '/var/folders/qz/8n1x2j5d7g93_kkr0vlp4jhm0000gn/T'
    expect(macTmp.length).toBeGreaterThan(45)
    const paths = containerlessWorkspacePaths(containerlessJobName('demo', UUID))
    const rebased = (p: string): string => path.join(macTmp, path.relative(os.tmpdir(), p))
    // The acpd socket is the longest thing under the dir.
    const longest = path.join(rebased(paths.acpSockDir), 'opencode-2.sock')
    expect(Buffer.byteLength(longest)).toBeLessThan(104)
    expect(Buffer.byteLength(rebased(paths.tmuxSock))).toBeLessThan(104)
  })

  it('refuses a path that could not survive a worktree\'s command text', () => {
    // The command builders above the driver quote for their own nesting and
    // cannot also quote a path — under the pod driver every one of them is a
    // constant. Here they are data-dir derived, so a space has to be caught
    // rather than silently running a `cd` somewhere else.
    const paths = containerlessWorkspacePaths(containerlessJobName('demo', UUID))
    expect(() => assertShellSafePaths(paths)).not.toThrow()
    expect(() => assertShellSafePaths({ ...paths, workspaceDir: '/My Drive/yaac/wt' }))
      .toThrow(/cannot be carried into a worktree's shell commands/)
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
    // The one path here that is not this driver's own. Everything that reads a
    // conversation — the chat pane's tail, the registry's first-prompt scan,
    // a stopped worktree's transcript — looks at the shared project location,
    // so a driver-private directory would be written where nobody looks. It
    // also has to outlive the state dir: that is removed on stop, and a
    // stopped worktree's conversation stays readable.
    const paths = containerlessWorkspacePaths(containerlessJobName('demo', UUID))
    expect(paths.acpLogDir).toBe(acpLogDir('demo', UUID))
    expect(paths.acpLogDir.startsWith(workspaceStateDir('demo', UUID))).toBe(false)
  })

  it('answers identically for the same handle, without consulting anything', () => {
    // A probe of a workspace that is already gone still has to name the
    // socket it WOULD have had, so nothing here may depend on live state.
    const jobName = containerlessJobName('demo', UUID)
    expect(containerlessWorkspacePaths(jobName)).toEqual(containerlessWorkspacePaths(jobName))
  })
})
