/**
 * The tripwire that replaced the pre-database JSON import. What it must get
 * right is the pair of opposites: silence on an install that has nothing to
 * say (or the check becomes noise every operator learns to ignore), and a
 * message naming the actual file on one that does — because the whole failure
 * it exists for is that nothing else says anything at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir, serverLocalPath } from '@yaac/shared/paths'
import { projectDir } from '@yaac/shared/project-paths'
import { serverLog } from '#log'
import { warnAboutUnimportedLegacyData } from '#main/legacy-data-check'

vi.mock('#log', () => ({ serverLog: vi.fn() }))

const mockLog = vi.mocked(serverLog)

/** Everything the warning emitted, as one string. */
function logged(): string {
  return mockLog.mock.calls.map((c) => String(c[0])).join('\n')
}

describe('warnAboutUnimportedLegacyData', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-legacy-check-'))
    setDataDir(dataDir)
    mockLog.mockClear()
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('says nothing on an install with no pre-database files', async () => {
    // Including a fully-populated project dir: the check must key on the four
    // retired names, not on "this project looks old".
    await fs.mkdir(path.join(projectDir('proj'), 'claude'), { recursive: true })
    await fs.writeFile(path.join(projectDir('proj'), 'project.json'), '{}\n')

    await warnAboutUnimportedLegacyData()
    expect(mockLog).not.toHaveBeenCalled()
  })

  it('is silent with no projects directory at all', async () => {
    await warnAboutUnimportedLegacyData()
    expect(mockLog).not.toHaveBeenCalled()
  })

  it('names every retired store it finds, install- and project-scoped', async () => {
    await fs.mkdir(projectDir('alpha'), { recursive: true })
    await fs.mkdir(path.join(projectDir('beta'), 'opencode-meta'), { recursive: true })
    await fs.writeFile(serverLocalPath('.preferences.json'), '{}\n')
    await fs.writeFile(serverLocalPath('tokens.json'), '[]\n')
    await fs.writeFile(path.join(projectDir('alpha'), 'session-titles.json'), '{}\n')

    await warnAboutUnimportedLegacyData()

    const out = logged()
    expect(out).toContain(serverLocalPath('.preferences.json'))
    expect(out).toContain(serverLocalPath('tokens.json'))
    expect(out).toContain(path.join(projectDir('alpha'), 'session-titles.json'))
    // A directory counts as much as a file — opencode's meta was a dir.
    expect(out).toContain(path.join(projectDir('beta'), 'opencode-meta'))
    // The consequence, not just the paths: a user reading this must learn
    // that their checkouts are intact rather than conclude yaac ate them.
    expect(out).toMatch(/intact on disk/)
    expect(out).toMatch(/tokens\.json holds credentials/)
  })

  it('warns on a single project-scoped file with nothing else present', async () => {
    // The install-scoped pair is what a pre-database yaac always wrote, so a
    // check that only looked there would miss a data dir whose preferences
    // happened to be defaults.
    await fs.mkdir(projectDir('solo'), { recursive: true })
    await fs.writeFile(path.join(projectDir('solo'), 'session-titles.json'), '{}\n')

    await warnAboutUnimportedLegacyData()
    expect(logged()).toContain(path.join(projectDir('solo'), 'session-titles.json'))
  })

  it('resolves rather than throwing when the projects dir is unreadable', async () => {
    // Best-effort by construction: a failed stat is not a reason to fail a
    // server start, which is the whole reason runServer awaits this outside
    // its db-init try block.
    await fs.writeFile(path.join(dataDir, 'projects'), 'not a directory\n')
    await expect(warnAboutUnimportedLegacyData()).resolves.toBeUndefined()
  })
})
