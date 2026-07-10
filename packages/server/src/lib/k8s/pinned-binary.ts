import path from 'node:path'

export interface PinnedBinaryParams {
  /** Binary name: the PATH probe target, returned verbatim when found. */
  bin: string
  /** Human name for the download log line (defaults to `bin`). */
  displayName?: string
  /** Pinned release version; the cache filename is `<bin>-<version>`. */
  version: string
  /** Release tarball URL for the current platform/arch. */
  url: string
  /** Path of the binary inside the tarball (flat `cilium`, `linux-arm64/helm`). */
  tarMember: string
  /** Leading path components to strip when the member sits in a subdir. */
  stripComponents?: number
}

export interface PinnedBinaryDeps {
  /** execFile-style runner, injectable for tests. */
  run: (file: string, args: string[], opts?: { timeout?: number }) => Promise<unknown>
  homedir: () => string
  fileExists: (p: string) => Promise<boolean>
  /** Progress line printed before a download; silent when omitted. */
  log?: (message: string) => void
}

/**
 * Resolve a pinned external binary, preferring one on PATH and otherwise
 * fetching the pinned release once into ~/.cache/yaac/bin (curl | tar,
 * then mv + chmod). The shared download-and-pin convention behind the
 * cilium CLI (cluster-setup.ts ensureCiliumCli) and helm (vcluster.ts
 * ensureHelm); the binary fetch is the one network step, cached across
 * runs.
 */
export async function ensurePinnedBinary(
  p: PinnedBinaryParams,
  deps: PinnedBinaryDeps,
): Promise<string> {
  try {
    await deps.run('sh', ['-c', `command -v ${p.bin}`])
    return p.bin
  } catch { /* not on PATH — fall back to the pinned cache */ }

  const binDir = path.join(deps.homedir(), '.cache', 'yaac', 'bin')
  const bin = path.join(binDir, `${p.bin}-${p.version}`)
  if (await deps.fileExists(bin)) return bin

  deps.log?.(`Downloading pinned ${p.displayName ?? p.bin} ${p.version}...`)
  const strip = p.stripComponents ? ` --strip-components=${p.stripComponents}` : ''
  await deps.run('sh', [
    '-c',
    `mkdir -p '${binDir}' && curl -fsSL '${p.url}' | tar -xz -C '${binDir}'${strip} '${p.tarMember}' `
    + `&& mv '${binDir}/${p.bin}' '${bin}' && chmod +x '${bin}'`,
  ], { timeout: 120_000 })
  return bin
}
