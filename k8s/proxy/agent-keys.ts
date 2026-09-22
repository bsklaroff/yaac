/**
 * Loading identities into the pod-local ssh-agent.
 *
 * `ssh-add -h <host>` adds a destination constraint that binds the key to a
 * single hostname. ssh-add encodes the host's *public* key fingerprint into
 * that constraint, so it requires the host's pubkey to be available in a
 * known_hosts file at the moment ssh-add runs. The entries are kept in an
 * in-memory map keyed by host and the file is rewritten before each
 * ssh-add / ssh-add -D invocation; the agent itself stores the constraint,
 * so the file's later contents don't matter.
 *
 * The file path is always passed explicitly via `-H`: ssh-add's default
 * known_hosts lookup expands `~` through getpwuid(), NOT $HOME, and the
 * proxy's runtime uid (the server's host uid, set by runAsUser) either maps
 * to the image's `node` user — whose /home/node we never write — or to no
 * passwd entry at all. Both make the default lookup fail with "No host keys
 * found for destination".
 *
 * The whole identity set arrives at once (the credentials Secret's
 * `ssh-keys.json`), so a reload is clear-then-add, serialized and
 * coalesced: a second set arriving mid-reload is applied after, and only
 * the latest one — the agent must never end up holding a mix of two sets.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import type { SshKeyEntry } from './objects'

export interface AgentKeyLoaderDeps {
  /** The agent socket (entrypoint.sh starts the agent on it). */
  agentSock: string
  /** The known_hosts file ssh-add is pointed at with `-H`. */
  knownHostsFile: string
  /** Injected for tests — replaces node's spawn. */
  spawn?: typeof nodeSpawn
  log?: (message: string) => void
}

export interface AgentKeyLoader {
  /** Replace the agent's identities with `entries`. Resolves once the set
   *  it was called with — or a later one that superseded it — is loaded. */
  reload(entries: SshKeyEntry[]): Promise<void>
}

export function createAgentKeyLoader(deps: AgentKeyLoaderDeps): AgentKeyLoader {
  const spawn = deps.spawn ?? nodeSpawn
  const log = deps.log ?? ((m: string) => { console.log(m) })
  const knownHostsByHost = new Map<string, string>()

  function writeKnownHostsFile(): void {
    fs.mkdirSync(path.dirname(deps.knownHostsFile), { recursive: true, mode: 0o700 })
    const lines = [...knownHostsByHost.values()].map((e) => e.trim()).filter(Boolean)
    fs.writeFileSync(
      deps.knownHostsFile,
      lines.length ? lines.join('\n') + '\n' : '',
      { mode: 0o600 },
    )
  }

  function run(args: string[], stdin: string | null): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('ssh-add', args, {
        env: {
          ...process.env,
          SSH_AUTH_SOCK: deps.agentSock,
          SSH_ASKPASS: '/bin/false',
          SSH_ASKPASS_REQUIRE: 'force',
          DISPLAY: 'none:0',
        },
        stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`ssh-add ${args[0]} exited with code ${code ?? '?'}: ${stderr.trim()}`))
      })
      if (stdin !== null) child.stdin?.end(stdin)
    })
  }

  async function applySet(entries: SshKeyEntry[]): Promise<void> {
    knownHostsByHost.clear()
    writeKnownHostsFile()
    // ssh-add -D exits 0 even when the agent is empty.
    await run(['-D'], null)
    let loaded = 0
    for (const entry of entries) {
      knownHostsByHost.set(entry.host, entry.knownHostsEntry)
      writeKnownHostsFile()
      try {
        await run(['-H', deps.knownHostsFile, '-h', entry.host, '-'], entry.privateKey)
        loaded++
      } catch (err) {
        // A broken key must not keep the others out of the agent.
        log(`[proxy] ssh-agent: failed to load key for ${entry.host}: ${(err as Error).message}`)
      }
    }
    log(`[proxy] ssh-agent: loaded ${loaded} of ${entries.length} identit${entries.length === 1 ? 'y' : 'ies'}`)
  }

  // Latest-wins coalescing: `wanted` is the set the agent should end up
  // holding; one worker drains it, re-running while a newer set arrived
  // during the last apply.
  let wanted: SshKeyEntry[] | null = null
  let worker: Promise<void> | null = null

  function drain(): Promise<void> {
    worker ??= (async () => {
      try {
        while (wanted !== null) {
          const next = wanted
          wanted = null
          await applySet(next)
        }
      } finally {
        worker = null
      }
    })()
    return worker
  }

  return {
    reload: (entries) => {
      wanted = entries
      return drain()
    },
  }
}
