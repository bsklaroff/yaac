import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { installTmpDir } from '@yaac/shared/paths'
import { listGitCredentials } from '#db'
import { sshPublicKeyBlobFromLine, sshSign, sshString, sshUint32 } from '#lib/ssh-key'
import { serverLog } from '#log'

/**
 * The ssh-agent the server's own git signs through. `ssh` needs a private
 * key as a file or an agent, and generated keys must never be written to a
 * file (docs/git-credentials.md), so the server acts as its own agent: a
 * UNIX socket that answers "list identities" and "sign" and refuses
 * everything else. Identities come from the public-key column; a key's seed
 * is decrypted only inside the sign handler. (Ed25519 has no signature
 * flags, which keeps this small.)
 *
 * Rows are read per request, so a just-generated or removed key takes effect
 * immediately.
 *
 * Any process of this uid can reach the socket, the same boundary as the
 * database and secret key. It lives under the install's temp dir (like the
 * containerless tmux sockets) to keep the path short enough for `sun_path`.
 */

/** Client→agent request types (PROTOCOL.agent). */
const SSH_AGENTC_REQUEST_IDENTITIES = 11
const SSH_AGENTC_SIGN_REQUEST = 13
/** Agent→client answers. */
const SSH_AGENT_FAILURE = 5
const SSH_AGENT_IDENTITIES_ANSWER = 12
const SSH_AGENT_SIGN_RESPONSE = 14

/** OpenSSH's AGENT_MAX_LEN. A larger frame drops the connection. */
const AGENT_MAX_MESSAGE_BYTES = 256 * 1024

const FAILURE = frame(Buffer.from([SSH_AGENT_FAILURE]))

let server: net.Server | undefined

/** The agent socket, which `gitEnvForCredential` sets as `IdentityAgent`. */
export function gitSshAgentSock(): string {
  return path.join(installTmpDir(), 'git-agent.sock')
}

/** Start listening. Idempotent; removes a stale socket file first, since
 *  `listen` can't bind over one. */
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

/** Reply to one request. Anything but list-identities and sign (add,
 *  remove, lock, extension) gets FAILURE. */
async function answer(message: Buffer): Promise<Buffer> {
  const type = message[0]
  if (type === SSH_AGENTC_REQUEST_IDENTITIES) {
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

/** Reassemble whole frames from a byte stream; call `fail` on an invalid
 *  frame length. */
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
