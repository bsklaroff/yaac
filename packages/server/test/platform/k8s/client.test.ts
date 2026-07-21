import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  _resetK8sClientForTests,
  getBatchApi,
  getCoreApi,
  getKubeConfig,
} from '#platform/k8s/client'

const KUBECONFIG_YAML = `apiVersion: v1
kind: Config
clusters:
- name: test-cluster
  cluster:
    server: https://127.0.0.1:1
users:
- name: test-user
  user: {}
contexts:
- name: test-context
  context:
    cluster: test-cluster
    user: test-user
current-context: test-context
`

let tmpDir: string
let prevKubeconfig: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-kubeconfig-'))
  const file = path.join(tmpDir, 'config')
  await fs.writeFile(file, KUBECONFIG_YAML)
  prevKubeconfig = process.env.KUBECONFIG
  process.env.KUBECONFIG = file
  _resetK8sClientForTests()
})

afterEach(async () => {
  if (prevKubeconfig === undefined) delete process.env.KUBECONFIG
  else process.env.KUBECONFIG = prevKubeconfig
  _resetK8sClientForTests()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('k8s client singletons', () => {
  it('loads the same kubeconfig kubectl would (KUBECONFIG env honored)', () => {
    const kc = getKubeConfig()
    expect(kc.getCurrentContext()).toBe('test-context')
    expect(kc.getCurrentCluster()?.server).toBe('https://127.0.0.1:1')
  })

  it('memoizes the config and API clients until reset', () => {
    const kc = getKubeConfig()
    expect(getKubeConfig()).toBe(kc)
    const core = getCoreApi()
    expect(getCoreApi()).toBe(core)
    const batch = getBatchApi()
    expect(getBatchApi()).toBe(batch)
    _resetK8sClientForTests()
    expect(getKubeConfig()).not.toBe(kc)
    expect(getCoreApi()).not.toBe(core)
    expect(getBatchApi()).not.toBe(batch)
  })
})
