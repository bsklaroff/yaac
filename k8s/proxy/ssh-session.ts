/**
 * Ends a workspace's ssh session to a git host at the proxy
 * (docs/workspace-egress.md "Git over SSH"). The proxy answers as the ssh
 * server, with its own host key, to a workspace it already identified by
 * source address. It reads the one command git sends, opens its own session
 * to the real host with the key granted for that command's repo, and joins
 * the two. So a key reaches its own repo and nothing else, a workspace
 * holds no key, and a read-only repo takes no push.
 */

import type net from 'node:net'
import type { Duplex } from 'node:stream'
import ssh2, { type ServerChannel, type ServerHostKeyAlgorithm } from 'ssh2'
import type { SshRepoAccess } from './repo-grants'

/** How long the proxy's own login to the git host may take. */
const UPSTREAM_READY_TIMEOUT_MS = 30_000

/** The name workspaces know the proxy's host key under (`HostKeyAlias`),
 *  whichever git host they dial. Must match SSH_HOST_KEY_ALIAS in the
 *  server's proxy-constants.ts. */
export const SSH_HOST_KEY_ALIAS = 'yaac-proxy'

/** A new ed25519 host key for the proxy, in OpenSSH format. */
export function generateSshHostKey(): { privateKey: string; publicKey: string } {
  const pair = ssh2.utils.generateKeyPairSync('ed25519')
  return { privateKey: pair.private, publicKey: pair.public }
}

/** A git command as ssh carries it: the repo it names, and whether it
 *  writes there. */
export interface GitSshCommand {
  path: string
  write: boolean
}

/** One argument of a command: single-quoted as git quotes a path, or bare.
 *  A quoted `'` or `!` (which git writes as `'\''` and `'\!'`) or a
 *  control character is not matched, so such a path is refused rather than
 *  guessed at. The commands end where the pattern does (`(?![^])`). */
const ARG = String.raw`(?:'([^'\\\x00-\x1f]+)'|([\w./~+@=:-]+))`
const GIT_COMMAND = new RegExp(`^(git-upload-pack|git-receive-pack|git-upload-archive) ${ARG}(?![^])`)
const LFS_COMMAND = new RegExp(`^(?:git-lfs-authenticate|git-lfs-transfer) ${ARG} (download|upload)(?![^])`)

/**
 * Read the command a git client sends over ssh: a fetch, a push, an
 * archive, or one of the two LFS commands with its direction. Null for
 * anything else, a shell line included.
 */
export function parseGitSshCommand(command: string): GitSshCommand | null {
  const git = GIT_COMMAND.exec(command)
  if (git) return { path: git[2] ?? git[3], write: git[1] === 'git-receive-pack' }
  const lfs = LFS_COMMAND.exec(command)
  if (lfs) return { path: lfs[1] ?? lfs[2], write: lfs[3] === 'upload' }
  return null
}

/** ssh's names for the signature algorithms of a known_hosts key type. */
function hostKeyAlgorithms(type: string): ServerHostKeyAlgorithm[] {
  return type === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] : [type as ServerHostKeyAlgorithm]
}

export interface SshSessionOptions {
  /** The workspace's connection, ready for the ssh handshake. */
  client: Duplex
  /** The proxy's private host key. */
  hostKey: string
  /** The git host the workspace dialed. */
  hostname: string
  /** The project's access to the repo at a path on that host, read when
   *  the command arrives; null when the project has no such ssh repo. */
  accessAt: (repoPath: string) => SshRepoAccess | null
  /** Dial the git host's ssh port. */
  dial: () => Promise<Duplex>
  log?: (message: string) => void
}

/**
 * Serve one workspace ssh connection. Any login is accepted (the workspace
 * is already identified), and the user name it gives is the one the proxy
 * logs in upstream with. Only an `exec` of a git command passes; a shell,
 * a subsystem or any other command is refused on stderr with exit status
 * 1, as is a repo the project has no ssh grant for and a write to a
 * read-only one. `GIT_PROTOCOL` is carried to the host; no other variable
 * is.
 */
export function serveSshSession(opts: SshSessionOptions): void {
  const { client, hostKey, hostname, accessAt, dial } = opts
  const log = opts.log ?? ((m: string) => { console.log(m) })

  const server = new ssh2.Server({ hostKeys: [hostKey] }, (conn) => {
    let username = 'git'
    let upstream: ssh2.Client | undefined
    conn.on('authentication', (ctx) => {
      username = ctx.username
      ctx.accept()
    })
    conn.on('error', (err: Error) => { log(`[proxy] ssh session to ${hostname}: ${err.message}`) })
    conn.on('close', () => { upstream?.end() })
    conn.on('ready', () => {
      conn.on('session', (acceptSession) => {
        const session = acceptSession()
        const env: Record<string, string> = {}
        session.on('env', (accept, reject, info) => {
          if (info.key !== 'GIT_PROTOCOL') {
            reject?.()
            return
          }
          env[info.key] = info.val
          accept?.()
        })
        const refuseRequest = (_accept: unknown, reject?: () => void): void => { reject?.() }
        session.on('pty', refuseRequest)
        session.on('subsystem', refuseRequest)
        session.on('shell', (accept) => {
          refuse(accept(), 'ssh from a workspace carries only git; there is no shell here')
        })
        session.on('exec', (accept, _reject, info) => {
          const channel = accept()
          const parsed = parseGitSshCommand(info.command)
          if (parsed === null) {
            refuse(channel, 'ssh from a workspace carries only git commands, not: ' + info.command)
            return
          }
          const access = accessAt(parsed.path)
          if (access === null) {
            refuse(channel, `${parsed.path} on ${hostname} is not one of this project's ssh repos`)
            return
          }
          if (access.readOnly && parsed.write) {
            refuse(channel, `${parsed.path} on ${hostname} is read-only in this project, so the proxy refuses writes to it`)
            return
          }
          upstream = runUpstream(channel, info.command, env, access)
        })
      })
    })

    /** Answer a channel with why it was refused, and a failed exit. */
    function refuse(channel: ServerChannel, reason: string): void {
      log(`[proxy] REFUSED ssh to ${hostname}: ${reason}`)
      channel.stderr.write(`yaac: ${reason}\n`)
      channel.exit(1)
      channel.end()
    }

    /** Log in to the git host with the repo's key, run `command` there and
     *  join it to `channel`. */
    function runUpstream(
      channel: ServerChannel,
      command: string,
      env: Record<string, string>,
      access: SshRepoAccess,
    ): ssh2.Client {
      const up = new ssh2.Client()
      let joined = false
      const fail = (reason: string): void => {
        if (joined) {
          channel.close()
          return
        }
        joined = true
        refuse(channel, reason)
      }
      up.on('error', (err: Error & { level?: string }) => {
        fail(err.level === 'client-authentication'
          ? `${hostname} rejected this repo's ssh key`
          : `cannot reach ${hostname} over ssh: ${err.message}`)
      })
      up.on('ready', () => {
        up.exec(command, { env }, (err, stream) => {
          if (err) {
            fail(`${hostname} refused the command: ${err.message}`)
            return
          }
          joined = true
          let status = 1
          channel.pipe(stream)
          stream.pipe(channel, { end: false })
          stream.stderr.pipe(channel.stderr, { end: false })
          stream.on('exit', (code: number | null) => { status = code ?? 1 })
          stream.on('close', () => {
            channel.exit(status)
            channel.end()
            up.end()
          })
        })
      })
      dial().then((sock) => {
        up.connect({
          sock,
          username,
          privateKey: access.privateKey,
          readyTimeout: UPSTREAM_READY_TIMEOUT_MS,
          // Offer only the trusted keys' types, so the host presents one
          // of them, and accept nothing else.
          algorithms: { serverHostKey: [...new Set(access.hostKeys.flatMap((k) => hostKeyAlgorithms(k.type)))] },
          hostVerifier: (key: Buffer) => access.hostKeys.some((k) => k.blob === key.toString('base64')),
        })
      }, (err: Error) => { fail(`cannot reach ${hostname} over ssh: ${err.message}`) })
      return up
    }
  })
  // ssh2 asks for a net.Socket and uses it only as a stream.
  server.injectSocket(client as net.Socket)
}
