/**
 * Runs iptables: picks the backend and applies the chain rendered by
 * rules.ts.
 *
 * Nodes may use iptables-legacy (kind's default) or iptables-nft, and
 * rules written to the other backend are silently ignored. netd therefore
 * picks the backend holding Calico's `cali-*` chains, then the one with
 * more rules, then legacy.
 */

import { spawn } from 'node:child_process'

export type IptablesBackend = 'legacy' | 'nft'

export interface IptablesRunner {
  run: (
    file: string,
    args: string[],
    opts?: { input?: string },
  ) => Promise<{ stdout: string; stderr: string }>
}

/**
 * Uses spawn so `iptables-restore` can read its document on stdin. Rejects
 * with the command's stderr, which names the offending line.
 */
export const defaultRunner: IptablesRunner = {
  run: (file, args, opts) => new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: [opts?.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (c: string) => { stdout += c })
    child.stderr?.on('data', (c: string) => { stderr += c })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${file} ${args.join(' ')} exited ${code}: ${stderr.trim()}`))
    })
    if (opts?.input !== undefined) child.stdin?.end(opts.input)
  }),
}

/** Binary names for one backend. */
export function backendBinaries(backend: IptablesBackend): {
  iptables: string
  save: string
  restore: string
} {
  const suffix = backend === 'nft' ? 'nft' : 'legacy'
  return {
    iptables: `iptables-${suffix}`,
    save: `iptables-${suffix}-save`,
    restore: `iptables-${suffix}-restore`,
  }
}

/**
 * Score a backend's `-t nat` dump: Calico's chains win outright, otherwise
 * the rule count.
 */
export function scoreBackendDump(natDump: string): number {
  if (natDump.includes('cali-PREROUTING')) return 1_000_000
  return natDump.split('\n').filter((l) => l.startsWith('-A')).length
}

/**
 * Pick the backend Calico and kube-proxy use. A backend whose binaries
 * fail scores -1; ties go to legacy, kind's default.
 */
export async function detectBackend(
  runner: IptablesRunner = defaultRunner,
): Promise<IptablesBackend> {
  const scores = new Map<IptablesBackend, number>()
  for (const backend of ['legacy', 'nft'] as const) {
    try {
      const { stdout } = await runner.run(backendBinaries(backend).save, ['-t', 'nat'])
      scores.set(backend, scoreBackendDump(stdout))
    } catch {
      scores.set(backend, -1)
    }
  }
  const legacy = scores.get('legacy') ?? -1
  const nft = scores.get('nft') ?? -1
  return nft > legacy ? 'nft' : 'legacy'
}

/**
 * Ensure nat PREROUTING jumps to netd's chain, exactly once. The jump is
 * appended, never inserted, so it stays out of Felix's way (see rules.ts)
 * and runs after kube-proxy's KUBE-SERVICES, which means ClusterIP traffic
 * is already DNAT'd and never redirected. The chain must already exist
 * (the restore document creates it).
 */
export async function ensurePreroutingJump(
  backend: IptablesBackend,
  chain: string,
  runner: IptablesRunner = defaultRunner,
): Promise<void> {
  const { iptables } = backendBinaries(backend)
  // `-t nat` must precede the command verb; iptables rejects the reverse.
  const spec = (verb: string): string[] => ['-t', 'nat', verb, 'PREROUTING', '-j', chain]
  try {
    await runner.run(iptables, spec('-C'))
    return
  } catch {
    // Not present yet; add it below.
  }
  await runner.run(iptables, spec('-A'))
}

/** Apply a rendered restore document (`--noflush`: only our chain changes). */
export async function applyRestore(
  backend: IptablesBackend,
  document: string,
  runner: IptablesRunner = defaultRunner,
): Promise<void> {
  await runner.run(backendBinaries(backend).restore, ['--noflush'], { input: document })
}

/**
 * Remove the redirect chain on shutdown so no rules point at listeners
 * that are gone. Best-effort; a missing chain is fine.
 */
export async function teardownChain(
  backend: IptablesBackend,
  chain: string,
  runner: IptablesRunner = defaultRunner,
): Promise<void> {
  const { iptables } = backendBinaries(backend)
  await runner.run(iptables, ['-t', 'nat', '-D', 'PREROUTING', '-j', chain]).catch(() => {})
  await runner.run(iptables, ['-t', 'nat', '-F', chain]).catch(() => {})
  await runner.run(iptables, ['-t', 'nat', '-X', chain]).catch(() => {})
}

/** Read the node's routing table (input for parsePodVeths). */
export async function readIpRoutes(
  runner: IptablesRunner = defaultRunner,
): Promise<string> {
  const { stdout } = await runner.run('ip', ['route', 'show'])
  return stdout
}
