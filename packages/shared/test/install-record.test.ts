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

  it('lifts a legacy record out of server.json into install.json, for the client data dir only', async () => {
    await fs.mkdir(path.dirname(clientLocalPath('server.json')), { recursive: true })
    await fs.writeFile(clientLocalPath('server.json'), JSON.stringify({
      url: '', enabled: false, saved: [], driver: 'k8s', installId: 'i-1', byo: true,
    }))
    // Another data dir never inherits the client tier's legacy record.
    expect(await readInstallRecord(path.join(dir, 'cluster'))).toBeNull()

    expect(await readInstallRecord()).toEqual({ driver: 'k8s', installId: 'i-1', byo: true })
    const written = await fs.stat(installRecordPath())
    expect(written.mode & 0o777).toBe(0o600)
    // From now on install.json answers, whatever server.json says.
    await fs.writeFile(clientLocalPath('server.json'), JSON.stringify({ url: '', enabled: false, saved: [] }))
    expect(await recordedDriver()).toBe('k8s')
  })

  it('re-lifts over an install.json a crash left torn, but never over one another process wrote', async () => {
    await fs.mkdir(path.dirname(clientLocalPath('server.json')), { recursive: true })
    await fs.writeFile(clientLocalPath('server.json'), JSON.stringify({ url: '', enabled: false, saved: [], driver: 'k8s' }))
    await fs.mkdir(getDataDir(), { recursive: true })
    await fs.writeFile(installRecordPath(), '')
    expect(await readInstallRecord()).toEqual({ driver: 'k8s' })
    expect(JSON.parse(await fs.readFile(installRecordPath(), 'utf8'))).toEqual({ driver: 'k8s' })
  })
})

describe('recordInstall', () => {
  it('mirrors the client data dir\'s record into server.json, for an older yaac, keeping the selection', async () => {
    await fs.mkdir(path.dirname(clientLocalPath('server.json')), { recursive: true })
    await fs.writeFile(clientLocalPath('server.json'), JSON.stringify({ url: 'https://a.ts.net', enabled: true, saved: [{ url: 'https://a.ts.net' }] }))
    await recordInstall({ driver: 'k8s', installId: 'i-1' })
    expect(JSON.parse(await fs.readFile(clientLocalPath('server.json'), 'utf8'))).toEqual({
      url: 'https://a.ts.net', enabled: true, saved: [{ url: 'https://a.ts.net' }], driver: 'k8s', installId: 'i-1',
    })
    // Another install's record stays out of it.
    useInstallDataDir(path.join(dir, 'cluster'))
    await recordInstall({ driver: 'k8s', installId: 'i-2' })
    expect(JSON.parse(await fs.readFile(clientLocalPath('server.json'), 'utf8'))).toMatchObject({ installId: 'i-1' })
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
      url: 'http://127.0.0.1:8787', enabled: true, saved: [], driver: 'k8s', installId: 'i-1',
    }))
    expect(await clusterDataDir()).toBe(path.join(dir, '.yaac'))
    expect(JSON.parse(await fs.readFile(path.join(dir, '.yaac', 'install.json'), 'utf8'))).toEqual({ driver: 'k8s', installId: 'i-1' })
  })

  it('is an overridden data dir itself: one data dir, one install', async () => {
    vi.stubEnv('HOME', dir)
    expect(await clusterDataDir()).toBe(path.join(dir, 'data'))
  })
})
