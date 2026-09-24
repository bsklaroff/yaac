import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { installTmpDir } from '@yaac/shared/paths'
import { listGitCredentials } from '#db'
import { sshPublicKeyBlobFromLine, sshSign, sshString, sshUint32 } from '#lib/ssh-key'
import { serverLog } from '#log'

/**
 * The ssh-agent the server's OWN git signs through.
 *
 * `ssh` takes a private key as a path or an agent, and a path is the one
 * thing a generated key must never have (docs/git-credentials.md). So the server
 * is its own agent: a UNIX socket that answers the two requests an ssh
 * client makes of one — which identities exist, and sign this — and
 * refuses everything else. Identities are answered from the public column;
 * the seed is opened inside the sign handler, for the one key the request
 * named. Ed25519 has no signature flags, which is what keeps the whole
 * protocol subset this short.
 *
 * Rows are read per request rather than cached, so a key generated or
 * removed a moment ago is what the next fetch signs with, with no resync
 * step to forget.
 *
 * The socket is reachable by any process of this uid, which is the same
 * boundary the database file and the secret key already sit behind. It
 * lives under the install-keyed temp dir the containerless driver uses for
 * its tmux sockets, for the same `sun_path` reason.
 */

/** Client→agent request types (PROTOCOL.agent). */
const SSH_AGENTC_REQUEST_IDENTITIES = 11
const SSH_AGENTC_SIGN_REQUEST = 13
/** Agent→client answers. */
const SSH_AGENT_FAILURE = 5
const SSH_AGENT_IDENTITIES_ANSWER = 12
const SSH_AGENT_SIGN_RESPONSE = 14

/** OpenSSH's own AGENT_MAX_LEN: a frame claiming more is not the agent
 *  protocol, so the connection is dropped rather than buffered. */
const AGENT_MAX_MESSAGE_BYTES = 256 * 1024

const FAILURE = frame(Buffer.from([SSH_AGENT_FAILURE]))

let server: net.Server | undefined

/** Where the agent listens — what `gitEnvForCredential` names as `IdentityAgent`. */
export function gitSshAgentSock(): string {
  return path.join(installTmpDir(), 'git-agent.sock')
}

/**
 * Start listening. Idempotent; a socket file a previous life left behind is
 * removed first, since `listen` refuses to bind over one.
 */
export async function startGitSshAgent(): Promise<void> {
  if (server) return
  const sock = gitSshAgentSock()
  await fs.mkdir(path.dirname(sock), { recursive: true, mode: 0o700 })
  await fs.rm(sock, { force: true })
  const listener = net.createServer((socket) => {
    socket.on('error', () => socket.destroy())
    socket.on('data', frameReader((message) => {
      void answer(message).then(
        (reply) => { socket.write(reply) },
        (err) => {
          serverLog(`[git] ssh-agent request failed: ${err instanceof Error ? err.message : String(err)}`)
          socket.write(FAILURE)
        },
      )
    }, () => socket.destroy()))
  })
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(sock, () => {
      listener.off('error', reject)
      resolve()
    })
  })
  await fs.chmod(sock, 0o600)
  server = listener
}

export async function stopGitSshAgent(): Promise<void> {
  const listener = server
  if (!listener) return
  server = undefined
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  await fs.rm(gitSshAgentSock(), { force: true }).catch(() => { /* already gone */ })
}

/** One reply for one request. Anything but the two admitted types — add,
 *  remove, lock, extension — is a FAILURE. */
async function answer(message: Buffer): Promise<Buffer> {
  const type = message[0]
  if (type === SSH_AGENTC_REQUEST_IDENTITIES) {
    // From the public column: nothing is opened to say which keys exist.
    const keys = await listSshKeys()
    return frame(Buffer.concat([
      Buffer.from([SSH_AGENT_IDENTITIES_ANSWER]),
      sshUint32(keys.length),
      ...keys.map((k) => Buffer.concat([
        sshString(sshPublicKeyBlobFromLine(k.publicKey)),
        sshString(k.name),
      ])),
    ]))
  }
  if (type === SSH_AGENTC_SIGN_REQUEST) {
    // string key blob, string data, uint32 flags (none apply to ed25519).
    const blob = readString(message, 1)
    const data = readString(message, 1 + 4 + blob.length)
    const key = (await listSshKeys()).find((k) => sshPublicKeyBlobFromLine(k.publicKey).equals(blob))
    const seed = await key?.openSecret()
    if (seed === undefined) return FAILURE
    return frame(Buffer.concat([
      Buffer.from([SSH_AGENT_SIGN_RESPONSE]),
      sshString(sshSign(Buffer.from(seed, 'base64'), data)),
    ]))
  }
  return FAILURE
}

async function listSshKeys(): Promise<Array<{ name: string; publicKey: string; openSecret: () => Promise<string | undefined> }>> {
  return (await listGitCredentials()).flatMap((c) => c.publicKey === null ? [] : [{ ...c, publicKey: c.publicKey }])
}

/** Wire framing: uint32 length, then the message (type byte first). */
function frame(message: Buffer): Buffer {
  return Buffer.concat([sshUint32(message.length), message])
}

function readString(buf: Buffer, offset: number): Buffer {
  const length = buf.readUInt32BE(offset)
  const end = offset + 4 + length
  if (end > buf.length) throw new Error('truncated agent message')
  return buf.subarray(offset + 4, end)
}

/** Reassemble whole frames from a byte stream; `fail` on one that cannot
 *  be the agent protocol. */
function frameReader(
  onMessage: (message: Buffer) => void,
  fail: () => void,
): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0)
  return (chunk) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (buf.length < 4) return
      const length = buf.readUInt32BE(0)
      if (length === 0 || length > AGENT_MAX_MESSAGE_BYTES) {
        fail()
        return
      }
      if (buf.length < 4 + length) return
      onMessage(buf.subarray(4, 4 + length))
      buf = buf.subarray(4 + length)
    }
  }
}
