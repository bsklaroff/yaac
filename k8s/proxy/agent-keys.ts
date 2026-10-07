/**
 * Loads SSH identities into the pod-local ssh-agent.
 *
 * Each key is added with one `ssh-add -h <host>` destination constraint per
 * host among its projects, so the agent signs only for those hosts. ssh-add
 * needs those hosts' public keys in a known_hosts file while it runs, so the
 * file is rewritten before each add. Which workspaces may use a key is
 * decided by ssh-agent-relay.ts.
 *
 * The known_hosts path is passed with `-H` because ssh-add's default lookup
 * resolves `~` via getpwuid(), not $HOME, and the proxy's uid has no usable
 * home directory.
 *
 * A reload clears the agent and adds the whole set. Reloads are serialized
 * and only the latest pending set is applied, so the agent never holds a mix
 * of two sets.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import type { SshCredentialEntry } from './objects'

/** What the agent holds for one key: the key and its host constraints. */
export type AgentIdentity = { privateKey: string; hosts: string[]; knownHosts: string[] }

const distinct = (values: string[]): string[] => [...new Set(values)].sort()

/**
 * The part of the ssh credential entries the agent is loaded from. A reload
 * is needed only when this changes (keys, hosts, or host keys), not when a
 * key's projects change. Keys with no project are skipped, and a key listed
 * more than once (two owners holding it) is loaded once with every host.
 * Sorted so order changes compare equal.
 */
export function agentIdentities(entries: SshCredentialEntry[]): AgentIdentity[] {
  const grants = new Map<string, SshCredentialEntry['projects']>()
  for (const e of entries) grants.set(e.privateKey, [...grants.get(e.privateKey) ?? [], ...e.projects])
  return [...grants]
    .filter(([, projects]) => projects.length > 0)
    .map(([privateKey, projects]) => ({
      privateKey,
      hosts: distinct(projects.map((p) => p.host)),
      knownHosts: distinct(projects.map((p) => p.knownHostsEntry.trim()).filter(Boolean)),
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

  // `wanted` is the latest set requested; one worker applies it and loops
  // while a newer set arrived.
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
