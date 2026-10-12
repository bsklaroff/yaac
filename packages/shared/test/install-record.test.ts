import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  clusterDataDir,
  installRecordPath,
  readInstallRecord,
  recordInstall,
  recordedDriver,
} from '#install-record'
import { clientLocalPath, getDataDir, setDataDir, useInstallDataDir } from '#paths'
import { readServerConfig } from '#server-config'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-install-'))
  setDataDir(path.join(dir, 'data'))
})

afterEach(async () => {
  useInstallDataDir('')
  setDataDir('')
  vi.unstubAllEnvs()
  await fs.rm(dir, { recursive: true, force: true })
})

describe('readInstallRecord', () => {
  it('is null when absent or malformed, and keeps only the known fields', async () => {
    expect(await readInstallRecord()).toBeNull()
    await fs.mkdir(getDataDir(), { recursive: true })
    await fs.writeFile(installRecordPath(), 'not json')
    expect(await readInstallRecord()).toBeNull()
    await fs.writeFile(installRecordPath(), JSON.stringify({ driver: 'nomad', installId: 'i-1', byo: 'yes', extra: 1 }))
    expect(await readInstallRecord()).toEqual({ installId: 'i-1' })
  })

  it('round-trips the legacy data-dir hash an older cluster install is still named after, and nothing else in its place', async () => {
    await recordInstall({ driver: 'k8s', installId: 'i-1', legacyDataDirHash: '0123456789abcdef', legacyNames: true })
    expect(await readInstallRecord())
      .toEqual({ driver: 'k8s', installId: 'i-1', legacyDataDirHash: '0123456789abcdef', legacyNames: true })
    await recordInstall({ legacyDataDirHash: undefined, legacyNames: undefined })
    expect(await readInstallRecord()).toEqual({ driver: 'k8s', installId: 'i-1' })
    // It names a node tree a root `rm -rf` removes, so only the hash's
    // shape is kept.
    for (const bad of ['.', '../x', 'other-install-id', '0123456789ABCDEF']) {
      await fs.writeFile(installRecordPath(), JSON.stringify({ installId: 'i-1', legacyDataDirHash: bad }))
      expect(await readInstallRecord()).toEqual({ installId: 'i-1' })
    }
  })
})

describe('retireServerJsonRecord', () => {
  const writeServerJson = async (value: object): Promise<void> => {
    await fs.mkdir(path.dirname(clientLocalPath('server.json')), { recursive: true })
    await fs.writeFile(clientLocalPath('server.json'), JSON.stringify(value))
  }
  const serverJson = async (): Promise<unknown> => JSON.parse(await fs.readFile(clientLocalPath('server.json'), 'utf8'))

  it('moves a record from server.json into a missing install.json, for the client data dir only', async () => {
    await writeServerJson({ url: 'https://a.ts.net', saved: [], driver: 'k8s', installId: 'i-1', byo: true })
    // Another data dir never inherits the client tier's legacy record.
    expect(await readInstallRecord(path.join(dir, 'cluster'))).toBeNull()

    expect(await readInstallRecord()).toEqual({ driver: 'k8s', installId: 'i-1', byo: true })
    expect((await fs.stat(installRecordPath())).mode & 0o777).toBe(0o600)
    expect(await serverJson()).toEqual({ url: 'https://a.ts.net', saved: [] })
  })

  it('leaves an existing install.json alone and strips server.json, deleting a mirrored empty selection', async () => {
    await recordInstall({ driver: 'k8s', installId: 'i-1', origin: 'http://127.0.0.1:8787' })
    await writeServerJson({ url: 'https://a.ts.net', saved: [{ url: 'https://a.ts.net' }], driver: 'containerless' })
    expect(await readServerConfig()).toEqual({ url: 'https://a.ts.net', saved: [{ url: 'https://a.ts.net' }] })
    expect(await serverJson()).toEqual({ url: 'https://a.ts.net', saved: [{ url: 'https://a.ts.net' }] })
    expect(await readInstallRecord()).toEqual({ driver: 'k8s', installId: 'i-1', origin: 'http://127.0.0.1:8787' })

    // What the mirror wrote for a machine with no server selected.
    await writeServerJson({ url: '', saved: [], driver: 'k8s', installId: 'i-1' })
    expect(await readServerConfig()).toBeNull()
    await expect(fs.access(clientLocalPath('server.json'))).rejects.toThrow()
  })

  it('re-lifts over an install.json a crash left torn', async () => {
    await writeServerJson({ url: '', saved: [], driver: 'k8s' })
    await fs.mkdir(getDataDir(), { recursive: true })
    await fs.writeFile(installRecordPath(), '')
    expect(await readInstallRecord()).toEqual({ driver: 'k8s' })
    expect(JSON.parse(await fs.readFile(installRecordPath(), 'utf8'))).toEqual({ driver: 'k8s' })
  })
})

describe('recordInstall', () => {
  it('never writes the record into server.json', async () => {
    await fs.mkdir(path.dirname(clientLocalPath('server.json')), { recursive: true })
    const selection = { url: 'https://a.ts.net', saved: [{ url: 'https://a.ts.net' }] }
    await fs.writeFile(clientLocalPath('server.json'), JSON.stringify(selection))
    await recordInstall({ driver: 'k8s', installId: 'i-1' })
    expect(JSON.parse(await fs.readFile(clientLocalPath('server.json'), 'utf8'))).toEqual(selection)
  })

  it('records into the install data dir, merges later records, and drops fields set to undefined', async () => {
    useInstallDataDir(path.join(dir, 'cluster'))
    await recordInstall({ driver: 'k8s', installId: 'i-1', clusterUid: 'uid-1', kubeContext: 'prod', byo: true })
    await recordInstall({ clusterUid: 'uid-2', byo: undefined })
    expect(await readInstallRecord()).toEqual({ driver: 'k8s', installId: 'i-1', clusterUid: 'uid-2', kubeContext: 'prod' })
    expect(JSON.parse(await fs.readFile(path.join(dir, 'cluster', 'install.json'), 'utf8'))).toMatchObject({ installId: 'i-1' })
    // The client data dir's record is a different install's.
    expect(await readInstallRecord(path.join(dir, 'data'))).toBeNull()
  })
})

describe('recordedDriver', () => {
  it('is undefined until something stands a server up', async () => {
    expect(await recordedDriver()).toBeUndefined()
    await recordInstall({ driver: 'containerless' })
    expect(await recordedDriver()).toBe('containerless')
  })
})

describe('clusterDataDir', () => {
  it('is ~/.yaac-cluster beside a default ~/.yaac, unless ~/.yaac is already a cluster install', async () => {
    vi.stubEnv('HOME', dir)
    setDataDir(path.join(dir, '.yaac'))
    expect(await clusterDataDir()).toBe(path.join(dir, '.yaac-cluster'))
    await recordInstall({ driver: 'containerless' })
    expect(await clusterDataDir()).toBe(path.join(dir, '.yaac-cluster'))
    await recordInstall({ driver: 'k8s' })
    expect(await clusterDataDir()).toBe(path.join(dir, '.yaac'))
  })

  it('finds a ~/.yaac cluster install whose record is still only in server.json, lifting it on the way', async () => {
    // The upgrade case the two legacy shims cover together.
    vi.stubEnv('HOME', dir)
    setDataDir(path.join(dir, '.yaac'))
    await fs.mkdir(path.join(dir, '.yaac-client'), { recursive: true })
    await fs.writeFile(path.join(dir, '.yaac-client', 'server.json'), JSON.stringify({
      url: 'http://127.0.0.1:8787', saved: [], driver: 'k8s', installId: 'i-1',
    }))
    expect(await clusterDataDir()).toBe(path.join(dir, '.yaac'))
    expect(JSON.parse(await fs.readFile(path.join(dir, '.yaac', 'install.json'), 'utf8'))).toEqual({ driver: 'k8s', installId: 'i-1' })
  })

  it('is ~/.yaac-cluster once a cluster install moved there, even with a server.json an older yaac wrote', async () => {
    vi.stubEnv('HOME', dir)
    setDataDir(path.join(dir, '.yaac'))
    await recordInstall({ driver: 'k8s', installId: 'i-1' })
    await fs.mkdir(path.join(dir, '.yaac-client'), { recursive: true })
    await fs.writeFile(path.join(dir, '.yaac-client', 'server.json'), JSON.stringify({
      url: 'http://127.0.0.1:8787', saved: [], driver: 'k8s', installId: 'i-1',
    }))
    // The first command of any kind cleans server.json.
    await readServerConfig()
    await fs.rename(path.join(dir, '.yaac'), path.join(dir, '.yaac-cluster'))
    expect(await clusterDataDir()).toBe(path.join(dir, '.yaac-cluster'))
    await expect(fs.access(path.join(dir, '.yaac'))).rejects.toThrow()
  })

  it('is an overridden data dir itself: one data dir, one install', async () => {
    vi.stubEnv('HOME', dir)
    expect(await clusterDataDir()).toBe(path.join(dir, 'data'))
  })
})
