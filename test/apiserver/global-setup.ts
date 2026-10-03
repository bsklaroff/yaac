/**
 * Global setup for the `apiserver` tier: a real kube-apiserver and etcd,
 * started from controller-tools' pinned envtest release, with no kubelet,
 * scheduler or controllers. It checks what the unit fake cannot: the
 * requests `drivers/k8s/substrate/api.ts` sends as a real API server reads
 * them (serialization, server-side apply ownership, selectors, errors).
 *
 * The bundle is downloaded once into a cache and verified against the
 * pinned SHA-512 below. etcd keeps its data in a fresh temp dir, so every
 * run starts from an empty cluster.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import type { TestProject } from 'vitest/node'
import { freeLocalPort } from '@yaac/test-utils/kubectl-forward'

const ENVTEST_VERSION = 'v1.37.0'
const ENVTEST_SHA512: Record<string, string> = {
  'linux-amd64': '1d1c453633b72c161a5d5a886cde7ac850be1a2ac796a9e1d4ffacacc64868295bdd2d57aa66cd0c158f5ce510f5dfe3fbc61ac21bd3dcfb875bd70658aa663a',
  'linux-arm64': 'ae6a670502988200b0131c943758cfd3d3a58cf4e6247ef7f0e6a6467f1cd9a333c802e86101f0446b1b92a0e327387224e1e44fe1a4693da0929c6e529cfe9a',
  'darwin-amd64': '19a2a5376a8aa57a7b25ec5198834db29bf2ba0d6ff572d7f45ba683b13fb14c3ebec8069e92db66c39f1c7a9cff1bc2be879e2aacdc9fa8b8a7e861959bdf7b',
  'darwin-arm64': 'fb38cfacdd71b5e97a4d4cceac861af5f55069cf783f0e49cf181bfc32eb3e557c2091a534dc5d38f1b92c5ba142bc1979f215a5385b3630ea6a661be6fa161b',
}
const TOKEN = 'yaac-apiserver-test'

declare module 'vitest' {
  export interface ProvidedContext {
    apiserverKubeconfig: string
    apiserverKubectl: string
  }
}

/** The envtest binaries for this platform, downloading them on first use. */
async function envtestBinaries(): Promise<string> {
  const platform = `${os.platform()}-${os.arch() === 'x64' ? 'amd64' : os.arch()}`
  const sha = ENVTEST_SHA512[platform]
  if (!sha) throw new Error(`no pinned envtest bundle for ${platform}`)
  const dir = path.join(os.homedir(), '.cache', 'yaac-envtest', `${ENVTEST_VERSION}-${platform}`)
  if (await fs.access(path.join(dir, 'kube-apiserver')).then(() => true, () => false)) return dir

  const url = 'https://github.com/kubernetes-sigs/controller-tools/releases/download/'
    + `envtest-${ENVTEST_VERSION}/envtest-${ENVTEST_VERSION}-${platform}.tar.gz`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`downloading ${url}: HTTP ${String(res.status)}`)
  const archive = Buffer.from(await res.arrayBuffer())
  const got = crypto.createHash('sha512').update(archive).digest('hex')
  if (got !== sha) throw new Error(`${url}: SHA-512 ${got} does not match the pinned ${sha}`)

  // Read the tarball directly: it holds three regular files, and a `tar`
  // binary cannot be relied on (gVisor rejects GNU tar's directory calls).
  const tar = zlib.gunzipSync(archive)
  await fs.mkdir(dir, { recursive: true })
  for (let off = 0; off + 512 <= tar.length;) {
    const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/s, '')
    if (!name) break
    const size = Number.parseInt(tar.toString('utf8', off + 124, off + 136).replace(/\0.*$/s, '').trim() || '0', 8)
    if (tar[off + 156] === 0x30 || tar[off + 156] === 0) {
      await fs.writeFile(path.join(dir, path.basename(name)), tar.subarray(off + 512, off + 512 + size), { mode: 0o755 })
    }
    off += 512 + Math.ceil(size / 512) * 512
  }
  return dir
}

async function waitReady(kubectl: string, kubeconfig: string, log: string): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      spawn(kubectl, ['--kubeconfig', kubeconfig, 'get', '--raw', '/readyz'], { stdio: 'ignore' })
        .on('exit', (code) => { resolve(code === 0) })
        .on('error', () => { resolve(false) })
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`kube-apiserver did not become ready within 60s; see ${log}`)
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const bin = await envtestBinaries()
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-apiserver-'))
  const [etcdPort, peerPort, apiPort] = [await freeLocalPort(), await freeLocalPort(), await freeLocalPort()]
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  await fs.writeFile(path.join(work, 'sa.key'), privateKey.export({ type: 'pkcs1', format: 'pem' }))
  await fs.writeFile(path.join(work, 'sa.pub'), publicKey.export({ type: 'spki', format: 'pem' }))
  await fs.writeFile(path.join(work, 'tokens.csv'), `${TOKEN},admin,admin,system:masters\n`)

  const children: ChildProcess[] = []
  const start = async (file: string, args: string[], log: string): Promise<void> => {
    const out = await fs.open(path.join(work, log), 'w')
    children.push(spawn(path.join(bin, file), args, { stdio: ['ignore', out.fd, out.fd] }))
    await out.close()
  }
  const etcd = `http://127.0.0.1:${String(etcdPort)}`
  await start('etcd', [
    '--data-dir', path.join(work, 'etcd'),
    '--listen-client-urls', etcd, '--advertise-client-urls', etcd,
    '--listen-peer-urls', `http://127.0.0.1:${String(peerPort)}`,
  ], 'etcd.log')
  await start('kube-apiserver', [
    `--etcd-servers=${etcd}`,
    `--secure-port=${String(apiPort)}`,
    '--bind-address=127.0.0.1',
    `--cert-dir=${work}`,
    `--token-auth-file=${path.join(work, 'tokens.csv')}`,
    '--authorization-mode=AlwaysAllow',
    '--service-account-issuer=https://kubernetes.default.svc',
    `--service-account-key-file=${path.join(work, 'sa.pub')}`,
    `--service-account-signing-key-file=${path.join(work, 'sa.key')}`,
    '--service-cluster-ip-range=10.96.0.0/16',
    '--disable-admission-plugins=ServiceAccount',
  ], 'apiserver.log')

  const kubeconfig = path.join(work, 'kubeconfig')
  await fs.writeFile(kubeconfig, JSON.stringify({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{ name: 't', cluster: { server: `https://127.0.0.1:${String(apiPort)}`, 'insecure-skip-tls-verify': true } }],
    users: [{ name: 't', user: { token: TOKEN } }],
    contexts: [{ name: 't', context: { cluster: 't', user: 't' } }],
    'current-context': 't',
  }))
  const kubectl = path.join(bin, 'kubectl')
  await waitReady(kubectl, kubeconfig, path.join(work, 'apiserver.log'))
  project.provide('apiserverKubeconfig', kubeconfig)
  project.provide('apiserverKubectl', kubectl)

  return async () => {
    // The apiserver drains for a few seconds on SIGTERM; don't wait on it.
    for (const child of children.reverse()) {
      if (child.exitCode !== null) continue
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGKILL')
      await exited
    }
    await fs.rm(work, { recursive: true, force: true })
  }
}
