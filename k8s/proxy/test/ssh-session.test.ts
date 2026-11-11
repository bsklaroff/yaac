import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import ssh2 from 'ssh2'
import type { SshRepoAccess } from 'yaac-proxy-sidecar/repo-grants'
import { generateSshHostKey, parseGitSshCommand, serveSshSession } from 'yaac-proxy-sidecar/ssh-session'

/**
 * The proxy ending a workspace's ssh session, end to end over real ssh on
 * loopback: an ssh2 client stands in for the workspace's ssh, and an ssh2
 * server for the git host, which accepts one user key and answers each
 * command with what it was asked.
 */

const servers: net.Server[] = []
const hostKey = generateSshHostKey()
const otherHostKey = generateSshHostKey()
const repoKey = ssh2.utils.generateKeyPairSync('ed25519')
const strangerKey = ssh2.utils.generateKeyPairSync('ed25519')
const proxyKey = generateSshHostKey()
const blobOf = (publicKey: string): string => publicKey.split(' ')[1]

/** What the git host saw of each session it accepted. */
let upstreamSessions: Array<{ username: string; command: string; env: Record<string, string>; stdin: string }>
let upstreamPort = 0
let proxyPort = 0
/** The grants the proxy reads at each command. */
let grants: Record<string, SshRepoAccess>
let log: string[]

const access = (over: Partial<SshRepoAccess> = {}): SshRepoAccess => ({
  privateKey: repoKey.private,
  hostKeys: [{ type: 'ssh-ed25519', blob: blobOf(hostKey.publicKey) }],
  readOnly: false,
  ...over,
})

beforeAll(async () => {
  const accepted = ssh2.utils.parseKey(repoKey.public)
  if (accepted instanceof Error) throw accepted
  const upstream = new ssh2.Server({ hostKeys: [hostKey.privateKey] }, (conn) => {
    let username = ''
    conn.on('authentication', (ctx) => {
      username = ctx.username
      if (ctx.method === 'publickey' && ctx.key.data.equals(accepted.getPublicSSH())) ctx.accept()
      else ctx.reject(['publickey'])
    })
    conn.on('ready', () => conn.on('session', (acceptSession) => {
      const session = acceptSession()
      const env: Record<string, string> = {}
      session.on('env', (accept, _reject, info) => { env[info.key] = info.val; accept?.() })
      session.on('exec', (accept, _reject, info) => {
        const channel = accept()
        let stdin = ''
        channel.on('data', (c: Buffer) => { stdin += c.toString() })
        channel.on('end', () => {
          upstreamSessions.push({ username, command: info.command, env, stdin })
          channel.write(`out:${stdin}`)
          channel.stderr.write('err from host\n')
          channel.exit(7)
          channel.end()
        })
      })
    }))
    conn.on('error', () => {})
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  servers.push(upstream)
  upstreamPort = (upstream.address() as AddressInfo).port

  const proxy = net.createServer((socket) => {
    socket.on('error', () => {})
    serveSshSession({
      client: socket,
      hostKey: proxyKey.privateKey,
      hostname: 'git.example',
      accessAt: (repoPath) => grants[repoPath.replace(/^\//, '').replace(/\.git$/, '')] ?? null,
      dial: () => new Promise((resolve, reject) => {
        const sock = net.connect(upstreamPort, '127.0.0.1', () => resolve(sock))
        sock.once('error', reject)
      }),
      log: (m) => { log.push(m) },
    })
  })
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
  servers.push(proxy)
  proxyPort = (proxy.address() as AddressInfo).port
})

afterAll(() => { for (const s of servers) s.close() })

interface Outcome {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Run one command as the workspace's ssh would: logged in as `git` with no
 * key, trusting only the proxy's host key. `shell` asks for a shell instead.
 */
function run(command: string | null, opts: { stdin?: string; env?: Record<string, string> } = {}): Promise<Outcome> {
  upstreamSessions = []
  log = []
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client()
    client.on('error', reject)
    client.on('ready', () => {
      const onStream = (err: Error | undefined, stream: ssh2.ClientChannel): void => {
        if (err) { reject(err); return }
        const out: Outcome = { code: null, stdout: '', stderr: '' }
        stream.on('data', (c: Buffer) => { out.stdout += c.toString() })
        stream.stderr.on('data', (c: Buffer) => { out.stderr += c.toString() })
        stream.on('exit', (code: number | null) => { out.code = code })
        stream.on('close', () => { client.end(); resolve(out) })
        stream.end(opts.stdin ?? '')
      }
      if (command === null) client.shell(false, onStream)
      else client.exec(command, { env: opts.env ?? {} }, onStream)
    })
    client.connect({
      host: '127.0.0.1',
      port: proxyPort,
      username: 'git',
      hostVerifier: (key: Buffer) => key.toString('base64') === blobOf(proxyKey.publicKey),
    })
  })
}

describe('parseGitSshCommand', () => {
  it('reads the repo and direction of each command git and git-lfs send, and nothing else', () => {
    expect(parseGitSshCommand("git-upload-pack 'acme/repo.git'")).toEqual({ path: 'acme/repo.git', write: false })
    expect(parseGitSshCommand("git-upload-pack '/acme/repo.git'")).toEqual({ path: '/acme/repo.git', write: false })
    expect(parseGitSshCommand("git-upload-archive 'acme/repo.git'")).toEqual({ path: 'acme/repo.git', write: false })
    expect(parseGitSshCommand("git-receive-pack 'acme/repo.git'")).toEqual({ path: 'acme/repo.git', write: true })
    expect(parseGitSshCommand('git-lfs-authenticate acme/repo.git download')).toEqual({ path: 'acme/repo.git', write: false })
    expect(parseGitSshCommand("git-lfs-authenticate 'acme/repo.git' upload")).toEqual({ path: 'acme/repo.git', write: true })
    expect(parseGitSshCommand('git-lfs-transfer acme/repo.git upload')).toEqual({ path: 'acme/repo.git', write: true })
    for (const command of [
      '', 'ls', 'git-upload-pack', "git-upload-pack 'a' 'b'", "git-upload-pack 'a'; id", "git-upload-pack 'a' && id",
      "git-upload-pack 'it'\\''s'", 'git-upload-pack $(id)', "sh -c git-upload-pack 'a'", "git-shell -c git-upload-pack 'a'",
      'git-lfs-authenticate acme/repo.git', 'git-lfs-authenticate acme/repo.git verify', "git-upload-pack 'a'\nid",
      "git-upload-pack 'a'\n", "git-upload-pack 'a\nb'", 'git-lfs-transfer a upload\n',
    ]) expect(parseGitSshCommand(command), command).toBeNull()
  })
})

describe('generateSshHostKey', () => {
  it('makes an ed25519 key pair an ssh server can use', () => {
    const { privateKey, publicKey } = generateSshHostKey()
    expect(publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+$/)
    expect(ssh2.utils.parseKey(privateKey)).not.toBeInstanceOf(Error)
  })
})

describe('serveSshSession', () => {
  it('runs a git command on the host with the repo\'s key, joining both ways with its exit status', async () => {
    grants = { 'acme/repo': access() }
    const fetch = await run("git-upload-pack 'acme/repo.git'", {
      stdin: 'wants', env: { GIT_PROTOCOL: 'version=2', LANG: 'C', AWS_SECRET_ACCESS_KEY: 'x' },
    })
    expect(fetch).toEqual({ code: 7, stdout: 'out:wants', stderr: 'err from host\n' })
    // The host saw the workspace's user name and command, git's protocol
    // version, and no other variable.
    expect(upstreamSessions).toEqual([{
      username: 'git', command: "git-upload-pack 'acme/repo.git'", env: { GIT_PROTOCOL: 'version=2' }, stdin: 'wants',
    }])
    const push = await run("git-receive-pack '/acme/repo.git'", { stdin: 'pack' })
    expect(push.stdout).toBe('out:pack')
    expect(upstreamSessions[0].command).toBe("git-receive-pack '/acme/repo.git'")
  })

  it('refuses, without logging in anywhere, whatever is not git to one of the project\'s repos', async () => {
    grants = { 'acme/repo': access(), 'acme/ro': access({ readOnly: true }) }
    const refused: Array<[command: string | null, reason: RegExp]> = [
      ['cat /etc/passwd', /carries only git commands/],
      ["git-upload-pack 'acme/repo.git'; id", /carries only git commands/],
      [null, /there is no shell here/],
      ["git-upload-pack 'acme/other.git'", /acme\/other\.git on git\.example is not one of this project's ssh repos/],
      ["git-receive-pack 'acme/ro.git'", /acme\/ro\.git on git\.example is read-only in this project/],
      ['git-lfs-authenticate acme/ro.git upload', /read-only in this project/],
    ]
    for (const [command, reason] of refused) {
      const outcome = await run(command)
      expect(outcome.code, String(command)).toBe(1)
      expect(outcome.stdout, String(command)).toBe('')
      expect(outcome.stderr, String(command)).toMatch(reason)
      expect(outcome.stderr.startsWith('yaac: '), String(command)).toBe(true)
      expect(upstreamSessions, String(command)).toEqual([])
    }
    // A read-only repo still fetches.
    expect((await run("git-upload-pack 'acme/ro.git'", { stdin: 'wants' })).stdout).toBe('out:wants')
  })

  it('reads the grant when the command arrives, so a change applies to the next command', async () => {
    grants = { 'acme/repo': access() }
    expect((await run("git-receive-pack 'acme/repo.git'")).code).toBe(7)
    grants = { 'acme/repo': access({ readOnly: true }) }
    expect((await run("git-receive-pack 'acme/repo.git'")).stderr).toMatch(/read-only/)
    grants = {}
    expect((await run("git-upload-pack 'acme/repo.git'")).stderr).toMatch(/not one of this project's ssh repos/)
  })

  it('logs in only to a host presenting a trusted key, and says so when the host refuses the repo\'s key', async () => {
    // The stored host key is another's: no login is attempted.
    grants = { 'acme/repo': access({ hostKeys: [{ type: 'ssh-ed25519', blob: blobOf(otherHostKey.publicKey) }] }) }
    const untrusted = await run("git-upload-pack 'acme/repo.git'")
    expect(untrusted.code).toBe(1)
    expect(untrusted.stderr).toMatch(/cannot reach git\.example over ssh/)
    expect(upstreamSessions).toEqual([])

    // A key the host does not know.
    grants = { 'acme/repo': access({ privateKey: strangerKey.private }) }
    const rejected = await run("git-upload-pack 'acme/repo.git'")
    expect(rejected.code).toBe(1)
    expect(rejected.stderr).toBe("yaac: git.example rejected this repo's ssh key\n")
    expect(upstreamSessions).toEqual([])
  })

  it('answers a host it cannot dial', async () => {
    const proxy = net.createServer((socket) => {
      serveSshSession({
        client: socket,
        hostKey: proxyKey.privateKey,
        hostname: 'down.example',
        accessAt: () => access(),
        dial: () => Promise.reject(new Error('connect ECONNREFUSED')),
        log: () => {},
      })
    })
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
    const realPort = proxyPort
    proxyPort = (proxy.address() as AddressInfo).port
    try {
      const outcome = await run("git-upload-pack 'acme/repo.git'")
      expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'yaac: cannot reach down.example over ssh: connect ECONNREFUSED\n' })
    } finally {
      proxyPort = realPort
      proxy.close()
    }
  })
})
