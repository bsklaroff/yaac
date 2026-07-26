/**
 * The impure iptables side: which binary to drive, and applying the
 * rendered chain.
 *
 * Backend detection is not optional. A kind node's `iptables` alternative
 * points at **iptables-legacy**, and Felix writes its chains through
 * whichever backend the node uses — so netd writing nft rules on a legacy
 * node would produce a chain that exists, counts packets, and is never
 * consulted by the packet path Calico and kube-proxy actually use. The
 * failure is silent and looks exactly like "the redirect isn't working",
 * so netd probes instead of assuming: the backend holding the live
 * `cali-*` chains wins, falling back to whichever holds more rules, and
 * finally to legacy (the kind default).
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
 * spawn rather than execFile: `iptables-restore` takes its document on
 * stdin, and the rendered chain can exceed a comfortable argv anyway.
 * Rejects with the command's stderr, which is where iptables reports the
 * offending line number.
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
 * Choose the backend Calico and kube-proxy are actually using. Scores each
 * by whether it carries Calico's chains (decisive) and otherwise by rule
 * count; a backend whose binaries are missing scores -1 and can never win.
 */
export function scoreBackendDump(natDump: string): number {
  if (natDump.includes('cali-PREROUTING')) return 1_000_000
  return natDump.split('\n').filter((l) => l.startsWith('-A')).length
}

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
  // Ties (both empty, both unavailable) resolve to legacy: it is what a
  // kind node's `iptables` alternative points at.
  return nft > legacy ? 'nft' : 'legacy'
}

/**
 * Ensure nat PREROUTING jumps to netd's chain, exactly once.
 *
 * APPENDED, never inserted — the hard constraint that keeps netd out of
 * Felix's way (see rules.ts). Appending also puts the redirect after
 * kube-proxy's KUBE-SERVICES, so ClusterIP flows are DNAT'd to their
 * backends and terminate before ever reaching it: in-cluster service
 * traffic is excluded for free rather than by an exclusion list netd would
 * have to keep in sync.
 *
 * `-C` first so re-running is a no-op; the chain must already exist, which
 * the restore document guarantees.
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
    // Not present (or the chain did not exist yet) — fall through to add.
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
 * Drop the whole redirect chain — used on shutdown so a netd that is
 * being replaced never leaves rules pointing at listeners that are gone.
 * Best-effort: a missing chain is success.
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
