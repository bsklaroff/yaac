import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import ssh2 from 'ssh2'
import { ProxyObjects } from 'yaac-proxy-sidecar/object-watch'
import { LABEL_WORKSPACE_ID } from 'yaac-proxy-sidecar/objects'
import { LiveTunnels } from 'yaac-proxy-sidecar/live-tunnels'
import { RefreshFlights } from 'yaac-proxy-sidecar/refresh-flight'
import { errorReply, type TokenReply } from 'yaac-proxy-sidecar/oauth-swap'
import { generateCA } from 'yaac-proxy-sidecar/mitm'
import { dispatchToUpstream, forwardPlainHttp, type DispatchContext } from 'yaac-proxy-sidecar/dispatch'
import { generateSshHostKey } from 'yaac-proxy-sidecar/ssh-session'

/**
 * Every dial a workspace can steer, against the non-public guard: the
 * transparent TLS tunnel, the MITM'd TLS path, a CONNECT (the SSH tunnel
 * listener's) and plain HTTP. DNS is stubbed, since it is what a rebinding
 * name lies through; upstreams are loopback servers, which only an explicit
 * allowlist entry or a server-named redirect may reach.
 */

/** Each name's answers, in order; the last repeats. */
const ANSWERS: Record<string, string[]> = {
  'rebind.test': ['10.1.2.3'],
  'mitm.test': ['127.0.0.1'],
  // Rebinds after its first answer; a second lookup would dial a public
  // address no loopback server listens on.
  'git.corp.test': ['127.0.0.1', '8.8.8.8'],
  'wild.corp.test': ['127.0.0.1'],
  // Private for its first (explicitly admitted) dial, then public.
  'pool.test': ['127.0.0.1', '1.1.1.1'],
}
let lookups: string[]
let blocked: string[]
let ctx: DispatchContext
const servers: net.Server[] = []
/** A raw TCP upstream that greets and hangs up, and a plain-HTTP one. */
let tcpPort = 0
let httpPort = 0

const listen = async <T extends net.Server>(server: T): Promise<T> => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  servers.push(server)
  return server
}
const portOf = (server: net.Server): number => (server.address() as AddressInfo).port

beforeAll(async () => {
  tcpPort = portOf(await listen(net.createServer((s) => s.end('hello'))))
  httpPort = portOf(await listen(http.createServer((req, res) => res.end(`upstream saw ${req.url}`))))

  const objects = new ProxyObjects({ log: () => {} })
  const register = (ws: string, reg: Record<string, unknown>): void => objects.applyRegistration({
    metadata: { name: `yaac-proxy-reg-${ws}`, labels: { [LABEL_WORKSPACE_ID]: ws } },
    data: { 'registration.json': JSON.stringify({ rules: [], projectId: 'demo', owner: 'o', ...reg }) },
  })
  register('star', {
    allowedHosts: ['*'],
    rules: [{ hostPattern: 'mitm.test', pathPattern: '/*', injections: [] }],
    upstreamRedirects: { 'redirected.test': { host: '127.0.0.1', port: httpPort } },
  })
  // `*` beside the exact entries: it admits no non-public address itself,
  // and must not stop the exact entries from admitting theirs.
  register('named', { allowedHosts: ['*', '127.0.0.1', 'git.corp.test', '192.0.2.1', 'pool.test', '*.corp.test'] })
  // A project with an ssh repo on a git host, here an ssh server that
  // answers each command with its own text.
  const gitHostKey = generateSshHostKey()
  const repoKey = generateSshHostKey()
  const gitHost = new ssh2.Server({ hostKeys: [gitHostKey.privateKey] }, (conn) => {
    conn.on('authentication', (auth) => {
      if (auth.method === 'publickey') auth.accept()
      else auth.reject(['publickey'])
    })
    conn.on('ready', () => conn.on('session', (accept) => {
      accept().on('exec', (acceptExec, _reject, info) => {
        const channel = acceptExec()
        channel.write(`ran:${info.command}`)
        channel.exit(0)
        channel.end()
      })
    }))
    conn.on('error', () => {})
  })
  await new Promise<void>((r) => gitHost.listen(0, '127.0.0.1', r))
  servers.push(gitHost)
  register('ssh', {
    projectId: 'sshp',
    allowedHosts: ['git.example'],
    upstreamRedirects: { 'git.example': { host: '127.0.0.1', port: (gitHost.address() as AddressInfo).port } },
  })
  objects.applyCredentials({
    metadata: { name: 'yaac-proxy-credentials' },
    data: { 'o.ssh-keys.json': Buffer.from(JSON.stringify([{
      privateKey: repoKey.privateKey,
      publicKey: repoKey.publicKey,
      grants: [{
        projectId: 'sshp', repoId: 'r1', host: 'git.example', path: 'acme/repo', readOnly: false, ghToken: false,
        knownHostsEntry: `git.example ${gitHostKey.publicKey}`,
      }],
    }])).toString('base64') },
  })

  const counts = new Map<string, number>()
  ctx = {
    ca: generateCA(),
    sshHostKey: generateSshHostKey().privateKey,
    objects,
    torAgent: null,
    refreshFlights: new RefreshFlights<TokenReply>((r) => r.rotatedTo, () => errorReply(504, 'slow')),
    captureRefreshed: () => {},
    noteGitUpstreamStatus: () => {},
    liveTunnels: new LiveTunnels(),
    recordBlockedHost: (_ws, host) => { blocked.push(host) },
    lookup: (hostname) => {
      lookups.push(hostname)
      const answers = ANSWERS[hostname]
      if (!answers) return Promise.reject(new Error(`getaddrinfo ENOTFOUND ${hostname}`))
      const n = counts.get(hostname) ?? 0
      counts.set(hostname, n + 1)
      return Promise.resolve([{ address: answers[Math.min(n, answers.length - 1)], family: 4 }])
    },
  }
}, 60_000)

beforeEach(() => {
  lookups = []
  blocked = []
})

afterAll(() => { for (const s of servers) s.close() })

/**
 * Open a connection the proxy dispatches as `workspaceId`'s to
 * `hostname:port`, as a CONNECT or as transparent TLS, and return what the
 * client reads before the proxy closes it.
 */
async function exchange(workspaceId: string, hostname: string, port: number, connect: boolean): Promise<string> {
  const entry = await listen(net.createServer((socket) => {
    void dispatchToUpstream(ctx, socket, hostname, String(port), workspaceId, { writeConnectOk: connect })
  }))
  const client = net.connect(portOf(entry), '127.0.0.1')
  client.on('error', () => {})
  let out = ''
  client.on('data', (c: Buffer) => { out += c.toString() })
  await once(client, 'close')
  entry.close()
  return out
}

/**
 * Forward a plain-HTTP GET as `workspaceId`'s to `hostname:port`. Gives up
 * after `timeoutMs`, answering status 0.
 */
async function plainGet(
  workspaceId: string, hostname: string, port: number, timeoutMs = 10_000,
): Promise<{ status: number; body: string }> {
  const entry = await listen(http.createServer((req, res) => {
    void forwardPlainHttp(ctx, req, res, workspaceId, { hostname, port, path: req.url ?? '/' })
  }))
  try {
    const res = await fetch(`http://127.0.0.1:${portOf(entry)}/x`, { signal: AbortSignal.timeout(timeoutMs) })
    return { status: res.status, body: await res.text() }
  } catch {
    return { status: 0, body: '' }
  } finally {
    entry.close()
  }
}

describe('dispatchToUpstream and forwardPlainHttp', () => {
  it('refuse every non-public destination a bare `*` admits, on every dial path', async () => {
    // Transparent TLS, tunneled and MITM'd: nothing to answer on, so dropped.
    expect(await exchange('star', 'rebind.test', 443, false)).toBe('')
    expect(await exchange('star', 'mitm.test', 443, false)).toBe('')

    // A CONNECT is told why, whatever form the address takes.
    for (const host of ['rebind.test', '169.254.169.254', '127.0.0.1', '0x7f.1', '2130706433', '168.63.129.16']) {
      const reply = await exchange('star', host, tcpPort, true)
      expect(reply, host).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/)
      expect(reply, host).toContain('non-public address')
    }
    // IPv6 is refused outright: the proxy dials IPv4 only.
    for (const host of ['[::ffff:127.0.0.1]', '[fd00:ec2::254]', '[2606:4700::1111]']) {
      expect(await exchange('star', host, tcpPort, true), host).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n[^]*IPv4 only/)
    }

    for (const host of ['rebind.test', '100.100.100.200', '127.0.0.1']) {
      const res = await plainGet('star', host, httpPort)
      expect(res.status, host).toBe(403)
      expect(res.body, host).toContain('non-public address')
    }
    // The allowlist did admit them, so none is offered as a host to allow.
    expect(blocked).toEqual([])
  }, 60_000)

  it('dial a non-public destination only an exact entry names, at the address checked', async () => {
    // Resolved once; the dial goes to that answer, not a second lookup's.
    expect(await exchange('named', 'git.corp.test', tcpPort, true))
      .toBe('HTTP/1.1 200 Connection Established\r\n\r\nhello')
    expect(lookups).toEqual(['git.corp.test'])

    // The entry and the destination compare in one spelling.
    expect(await plainGet('named', '0x7f.1', httpPort)).toEqual({ status: 200, body: 'upstream saw /x' })

    // A wildcard covers names in zones others control, so it admits only
    // public answers.
    const wild = await plainGet('named', 'wild.corp.test', httpPort)
    expect(wild.status).toBe(403)
    expect(wild.body).toContain('only an exact allowlist entry')
  }, 60_000)

  it('refuse a non-public destination the `*` beside exact entries admits', async () => {
    for (const host of ['rebind.test', '169.254.169.254', '10.1.2.3']) {
      const reply = await exchange('named', host, tcpPort, true)
      expect(reply, host).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/)
      expect(reply, host).toContain('non-public address')
    }
    expect(blocked).toEqual([])
  }, 30_000)

  it('keep an admitted non-public socket out of the pool other workspaces draw from', async () => {
    expect(await plainGet('named', 'pool.test', httpPort)).toEqual({ status: 200, body: 'upstream saw /x' })
    // pool.test now answers a public address, so `*` passes the check. Its
    // request must dial that address, not reuse named's loopback socket.
    const reused = await plainGet('star', 'pool.test', httpPort, 3_000)
    expect(reused.body).not.toContain('upstream saw')
  }, 30_000)

  it('fail fast, naming the egress policy, when the network drops an admitted non-public address', async () => {
    // TEST-NET-1 is never assigned, so nothing answers the SYN.
    const started = Date.now()
    const reply = await exchange('named', '192.0.2.1', 9, true)
    expect(reply).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/)
    expect(reply).toContain('blocked by the cluster\'s egress policy unless the network operator opens them')
    expect(Date.now() - started).toBeLessThan(8_000)
  }, 15_000)

  it('dial a server-named redirect target under `*`, though it is internal', async () => {
    const entry = await listen(net.createServer((socket) => {
      void dispatchToUpstream(ctx, socket, 'redirected.test', '443', 'star', { writeConnectOk: false })
    }))
    const body = await new Promise<string>((resolve, reject) => {
      https.get({
        host: '127.0.0.1', port: portOf(entry), servername: 'redirected.test', ca: ctx.ca.pem, path: '/r',
        headers: { host: 'redirected.test' },
      }, (res) => {
        let b = ''
        res.on('data', (c: Buffer) => { b += c.toString() })
        res.on('end', () => resolve(b))
      }).on('error', reject)
    })
    entry.close()
    expect(body).toBe('upstream saw /r')
    expect(lookups).toEqual([])
  }, 60_000)

  it('end an ssh session to a host the project has an ssh repo on, and log in there with the repo\'s key', async () => {
    const entry = await listen(net.createServer((socket) => {
      void dispatchToUpstream(ctx, socket, 'git.example', '22', 'ssh', { writeConnectOk: true })
    }))
    /** One command over a fresh CONNECT, as the workspace's ssh sends it. */
    const run = async (command: string): Promise<{ code: number | null; stdout: string; stderr: string }> => {
      const sock = net.connect(portOf(entry), '127.0.0.1')
      // The CONNECT's 200 comes first; ssh starts after it.
      await new Promise<void>((resolve) => {
        let head = ''
        const onData = (chunk: Buffer): void => {
          head += chunk.toString('latin1')
          const end = head.indexOf('\r\n\r\n')
          if (end === -1) return
          sock.removeListener('data', onData)
          sock.pause()
          expect(head.slice(0, end)).toBe('HTTP/1.1 200 Connection Established')
          sock.unshift(Buffer.from(head.slice(end + 4), 'latin1'))
          resolve()
        }
        sock.on('data', onData)
      })
      const client = new ssh2.Client()
      return new Promise((resolve, reject) => {
        client.on('error', reject)
        client.on('ready', () => client.exec(command, (err, stream) => {
          if (err) { reject(err); return }
          const out = { code: null as number | null, stdout: '', stderr: '' }
          stream.on('data', (c: Buffer) => { out.stdout += c.toString() })
          stream.stderr.on('data', (c: Buffer) => { out.stderr += c.toString() })
          stream.on('exit', (c: number | null) => { out.code = c })
          stream.on('close', () => { client.end(); resolve(out) })
          stream.end()
        }))
        client.connect({ sock, username: 'git', hostVerifier: () => true })
      })
    }
    // The project's repo: the proxy logs in to the host with its key.
    expect(await run("git-upload-pack 'acme/repo.git'"))
      .toEqual({ code: 0, stdout: "ran:git-upload-pack 'acme/repo.git'", stderr: '' })
    // Anything else is answered by the proxy and never reaches the host.
    const other = await run("git-upload-pack 'acme/other.git'")
    expect(other.code).toBe(1)
    expect(other.stderr).toContain("not one of this project's ssh repos")
    expect((await run('cat /etc/passwd')).stderr).toContain('carries only git commands')
    entry.close()
    expect(lookups).toEqual([])
  }, 30_000)
})
