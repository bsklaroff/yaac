import https from 'node:https'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import type tls from 'node:tls'
import { afterAll, describe, expect, it } from 'vitest'
import forge from 'node-forge'
import {
  mintServingCert,
  parseVclusterSni,
  sleepSliceName,
  startActivator,
} from 'yaac-proxy-sidecar/activator'

const INSTALL_NS = 'test-ns'
const VC = 'yvc-0a1b2c3d'
const VCNS = `${INSTALL_NS}-vc-0a1b2c3d`
const API_HOST = `${VC}.${VCNS}.svc.cluster.local`

describe('parseVclusterSni', () => {
  it('accepts only this install\'s <name>.<vc-ns>.svc.cluster.local with matching sids', () => {
    expect(parseVclusterSni(API_HOST, INSTALL_NS)).toEqual({ name: VC, namespace: VCNS })
    // Mismatched sid between name and namespace — a cross-vcluster
    // impersonation attempt.
    expect(parseVclusterSni(`yvc-0a1b2c3d.${INSTALL_NS}-vc-ffffffff.svc.cluster.local`, INSTALL_NS)).toBeNull()
    // Another install's namespace prefix.
    expect(parseVclusterSni(API_HOST, 'other-ns')).toBeNull()
    // Not a vcluster API host at all.
    expect(parseVclusterSni('example.com', INSTALL_NS)).toBeNull()
    expect(parseVclusterSni(undefined, INSTALL_NS)).toBeNull()
  })
})

describe('sleepSliceName', () => {
  it('matches the server-side slice name', () => {
    expect(sleepSliceName(VC)).toBe(`yaac-sleep-${VC}`)
  })
})

// ── Cert helpers ────────────────────────────────────────────────────────────

interface CertPair {
  certPem: string
  keyPem: string
}

function makeKeyAndCert(
  cn: string,
  opts: {
    o?: string
    ca?: { cert: forge.pki.Certificate; key: forge.pki.PrivateKey }
    sans?: string[]
    ipSans?: string[]
    isCa?: boolean
  } = {},
): { pair: CertPair; cert: forge.pki.Certificate; key: forge.pki.PrivateKey } {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = String(Math.floor(Math.random() * 1e12))
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + 3600_000)
  const attrs = [
    { name: 'commonName', value: cn },
    ...(opts.o ? [{ name: 'organizationName', value: opts.o }] : []),
  ]
  cert.setSubject(attrs)
  cert.setIssuer(opts.ca ? opts.ca.cert.subject.attributes : attrs)
  const exts: unknown[] = []
  if (opts.isCa) exts.push({ name: 'basicConstraints', cA: true })
  if (opts.sans || opts.ipSans) {
    exts.push({
      name: 'subjectAltName',
      altNames: [
        ...(opts.sans ?? []).map((d) => ({ type: 2, value: d })),
        ...(opts.ipSans ?? []).map((ip) => ({ type: 7, ip })),
      ],
    })
  }
  cert.setExtensions(exts as forge.pki.CertificateField[])
  cert.sign((opts.ca?.key ?? keys.privateKey) as forge.pki.rsa.PrivateKey, forge.md.sha256.create())
  return {
    pair: { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) },
    cert,
    key: keys.privateKey,
  }
}

describe('mintServingCert', () => {
  it('mints a CA-signed serverAuth leaf for the API host', { timeout: 30_000 }, () => {
    const ca = makeKeyAndCert('kubernetes', { isCa: true })
    const minted = mintServingCert(
      forge.pki.certificateToPem(ca.cert),
      forge.pki.privateKeyToPem(ca.key),
      API_HOST,
    )
    const leaf = forge.pki.certificateFromPem(minted.certPem)
    expect(ca.cert.verify(leaf)).toBe(true)
    expect((leaf.issuer.getField('CN') as { value: string }).value).toBe('kubernetes')
    const san = leaf.getExtension('subjectAltName') as { altNames: Array<{ value: string }> }
    expect(san.altNames.map((a) => a.value)).toEqual([API_HOST])
  })
})

// ── End-to-end: TLS termination, wake, park-then-307 ───────────────────────

describe('startActivator end-to-end', () => {
  const servers: Array<{ close: () => void }> = []
  afterAll(() => { for (const s of servers) s.close() })

  it('terminates TLS by SNI, wakes the vcluster, then 307s back to the same URL', { timeout: 60_000 }, async () => {
    // The vcluster PKI: one CA signs the real endpoint's serving leaf
    // and the admin client cert, matching the single-CA layout of the
    // vcluster's certs Secret.
    const ca = makeKeyAndCert('kubernetes', { isCa: true })
    const serving = makeKeyAndCert('kube-apiserver', { ca, sans: [API_HOST] })
    const client = makeKeyAndCert('kubernetes-super-admin', { o: 'system:masters', ca })
    const b64 = (pem: string): string => Buffer.from(pem).toString('base64')
    // Like the real Secret: the CA pair is present, but no serving leaf
    // for the API host exists — the activator must MINT one from the CA.
    const secretData = {
      'ca.crt': b64(forge.pki.certificateToPem(ca.cert)),
      'ca.key': b64(forge.pki.privateKeyToPem(ca.key)),
    }

    // Fake real endpoint: what the client's post-redirect re-dial (and
    // the activator's readiness probe) reaches. Echoes the peer CN so
    // the test can prove identity is presented NATIVELY by the client.
    const backend = https.createServer(
      {
        cert: serving.pair.certPem,
        key: serving.pair.keyPem,
        ca: forge.pki.certificateToPem(ca.cert),
        requestCert: true,
        rejectUnauthorized: false,
      },
      (req, res) => {
        const peer = (req.socket as tls.TLSSocket).getPeerCertificate()
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ headers: req.headers, peerCN: peer?.subject?.CN ?? null }))
      },
    )
    await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r))
    servers.push(backend)
    const backendPort = (backend.address() as AddressInfo).port

    // Fake host k8s API: the certs Secret, the deployment scale (0 until
    // patched), the control-plane pod (present once scaled), the slice.
    let replicas = 0
    let sliceDeleted = false
    const kApiCert = makeKeyAndCert('kubernetes', { ipSans: ['127.0.0.1'] })
    const kApi = https.createServer(
      { cert: kApiCert.pair.certPem, key: kApiCert.pair.keyPem },
      (req, res) => {
        res.setHeader('content-type', 'application/json')
        const url = req.url ?? ''
        if (req.method === 'GET' && url.endsWith(`/secrets/${VC}-certs`)) {
          res.end(JSON.stringify({ data: secretData }))
        } else if (url.endsWith(`/deployments/${VC}/scale`)) {
          if (req.method === 'PATCH') replicas = 1
          req.resume()
          req.on('end', () => res.end(JSON.stringify({ spec: { replicas } })))
        } else if (req.method === 'GET' && url.includes('/pods?')) {
          res.end(JSON.stringify({
            items: replicas === 1
              ? [{ status: { phase: 'Running', podIP: '127.0.0.1' } }]
              : [],
          }))
        } else if (req.method === 'GET' && url.includes('/endpointslices?')) {
          // The controller-managed slice: routing gate for the 307.
          res.end(JSON.stringify({
            items: replicas === 1
              ? [{
                  metadata: { labels: { 'endpointslice.kubernetes.io/managed-by': 'endpointslice-controller.k8s.io' } },
                  endpoints: [{ conditions: { ready: true } }],
                }]
              : [],
          }))
        } else if (req.method === 'DELETE' && url.includes(`/endpointslices/${sleepSliceName(VC)}`)) {
          sliceDeleted = true
          res.end('{}')
        } else {
          res.statusCode = 404
          res.end('{}')
        }
      },
    )
    await new Promise<void>((r) => kApi.listen(0, '127.0.0.1', r))
    servers.push(kApi)
    const kApiAddr = kApi.address() as AddressInfo

    const activator = startActivator({
      port: 0,
      backendPort,
      installNamespace: INSTALL_NS,
      log: () => {},
      api: {
        host: '127.0.0.1',
        port: String(kApiAddr.port),
        token: 'test-token',
        // Self-signed with a 127.0.0.1 IP SAN — its own PEM is the CA.
        ca: Buffer.from(kApiCert.pair.certPem),
      },
    })
    servers.push(activator)
    await new Promise<void>((r) => activator.once('listening', r))
    const activatorPort = (activator.address() as AddressInfo).port

    const call = (
      port: number,
      opts: { cert?: CertPair; headers?: Record<string, string>; servername?: string } = {},
    ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> =>
      new Promise((resolve, reject) => {
        const req = https.request(
          {
            host: '127.0.0.1',
            port,
            path: '/api/v1/namespaces',
            method: 'GET',
            servername: opts.servername ?? API_HOST,
            ca: forge.pki.certificateToPem(ca.cert),
            ...(opts.cert ? { cert: opts.cert.certPem, key: opts.cert.keyPem } : {}),
            headers: { host: `${API_HOST}:8443`, ...opts.headers },
          },
          (res) => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', (c: string) => { body += c })
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
          },
        )
        req.on('error', reject)
        req.end()
      })

    // 1. First touch: the minted serving chain validates against the
    // pinned CA (rejectUnauthorized is on), the wake runs, the slice is
    // deleted, and the response is a 307 back to the URL the client
    // dialed, on a connection the server closes.
    const first = await call(activatorPort, { cert: client.pair })
    expect(first.status).toBe(307)
    expect(first.headers.location).toBe(`https://${API_HOST}:8443/api/v1/namespaces`)
    expect(first.headers.connection).toBe('close')
    expect(replicas).toBe(1)
    expect(sliceDeleted).toBe(true)

    // 2. The re-dial (routed to the real endpoint now that the slice is
    // gone) authenticates the CLIENT's own cert natively — no forwarded
    // identity anywhere.
    const redial = await call(backendPort, { cert: client.pair })
    expect(redial.status).toBe(200)
    expect((JSON.parse(redial.body) as { peerCN: string | null }).peerCN).toBe('kubernetes-super-admin')

    // 3. Credential-less callers get the same 307: the activator
    // authenticates no one — the real apiserver will, on the re-dial.
    const anon = await call(activatorPort)
    expect(anon.status).toBe(307)

    // 4. A servername that is not a vcluster of this install: the
    // handshake itself fails — the activator serves nothing else.
    await expect(call(activatorPort, { servername: 'yvc-0a1b2c3d.other-vc-0a1b2c3d.svc.cluster.local' }))
      .rejects.toThrow()
  })
})
