/**
 * Loading identities into the pod-local ssh-agent.
 *
 * Each key is added once, with one `ssh-add -h <host>` destination
 * constraint per distinct host among the projects it is assigned to, so the
 * agent signs with it for those hosts and no other. ssh-add encodes the
 * hosts' *public* keys into the constraint, so it requires them in a
 * known_hosts file at the moment it runs: the file is rewritten before each
 * add to hold exactly that key's projects' entries. The agent itself stores
 * the constraint, so the file's later contents don't matter. Which
 * worktrees may use a key at all is the relay's business
 * (ssh-agent-relay.ts); the constraint is what bounds where it signs.
 *
 * The file path is always passed explicitly via `-H`: ssh-add's default
 * known_hosts lookup expands `~` through getpwuid(), NOT $HOME, and the
 * proxy's runtime uid (the server's host uid, set by runAsUser) either maps
 * to the image's `node` user — whose /home/node we never write — or to no
 * passwd entry at all. Both make the default lookup fail with "No host keys
 * found for destination".
 *
 * The whole identity set arrives at once (the credentials Secret's
 * `ssh-keys.json`, projected by `agentIdentities`), so a reload is
 * clear-then-add, serialized and coalesced: a second set arriving
 * mid-reload is applied after, and only the latest one — the agent must
 * never end up holding a mix of two sets.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import type { SshCredentialEntry } from './objects'

/** What the agent holds for one key: the key and its host constraints. */
export type AgentIdentity = { privateKey: string; hosts: string[]; knownHosts: string[] }

const distinct = (values: string[]): string[] => [...new Set(values)].sort()

/**
 * The projection of the credentials' ssh entries the agent is loaded from —
 * and so the thing a reload is decided on: which projects a key serves is
 * the relay's live concern, and only a change to a key or to its set of
 * hosts or host keys needs the agent emptied and refilled. A key assigned
 * to no project is not loaded. Sorted, so an order change is no change.
 */
export function agentIdentities(entries: SshCredentialEntry[]): AgentIdentity[] {
  return entries
    .filter((e) => e.projects.length > 0)
    .map((e) => ({
      privateKey: e.privateKey,
      hosts: distinct(e.projects.map((p) => p.host)),
      knownHosts: distinct(e.projects.map((p) => p.knownHostsEntry.trim()).filter(Boolean)),
    }))
    .sort((a, b) => a.privateKey.localeCompare(b.privateKey))
}

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
  /** Replace the agent's identities with `identities`. Resolves once the
   *  set it was called with — or a later one that superseded it — is loaded. */
  reload(identities: AgentIdentity[]): Promise<void>
}

export function createAgentKeyLoader(deps: AgentKeyLoaderDeps): AgentKeyLoader {
  const spawn = deps.spawn ?? nodeSpawn
  const log = deps.log ?? ((m: string) => { console.log(m) })

  function writeKnownHostsFile(lines: string[]): void {
    fs.mkdirSync(path.dirname(deps.knownHostsFile), { recursive: true, mode: 0o700 })
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

  async function applySet(identities: AgentIdentity[]): Promise<void> {
    writeKnownHostsFile([])
    // ssh-add -D exits 0 even when the agent is empty.
    await run(['-D'], null)
    let loaded = 0
    for (const identity of identities) {
      writeKnownHostsFile(identity.knownHosts)
      try {
        const constraints = identity.hosts.flatMap((host) => ['-h', host])
        await run(['-H', deps.knownHostsFile, ...constraints, '-'], identity.privateKey)
        loaded++
      } catch (err) {
        // A broken key must not keep the others out of the agent.
        log(`[proxy] ssh-agent: failed to load key for ${identity.hosts.join(', ')}: ${(err as Error).message}`)
      }
    }
    log(`[proxy] ssh-agent: loaded ${loaded} of ${identities.length} identit${identities.length === 1 ? 'y' : 'ies'}`)
  }

  // Latest-wins coalescing: `wanted` is the set the agent should end up
  // holding; one worker drains it, re-running while a newer set arrived
  // during the last apply.
  let wanted: AgentIdentity[] | null = null
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
    reload: (identities) => {
      wanted = identities
      return drain()
    },
  }
}
