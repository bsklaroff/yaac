/**
 * A workspace's environment as `NAME=VALUE` entries, the form a
 * `WorkspaceSpec` carries it in.
 */

type EnvVar = { name: string; value: string }

/** Split a `NAME=VALUE` entry at the first `=`. */
function parseEnvEntry(entry: string): EnvVar {
  const idx = entry.indexOf('=')
  if (idx < 0) return { name: entry, value: '' }
  return { name: entry.slice(0, idx), value: entry.slice(idx + 1) }
}

/**
 * Parse entries, dropping a repeat that matches the value already set. A
 * name set to two different values throws, with `conflict(name)` as the
 * message: one value would win silently on one substrate (a process
 * environment keeps the last), while a Kubernetes server-side apply
 * refuses the whole list, so the user should hear about it either way.
 */
export function mergeEnvEntries(
  entries: readonly string[],
  conflict: (name: string) => string = (name) => `environment variable ${name} is set to two different values`,
): EnvVar[] {
  const merged = new Map<string, string>()
  for (const entry of entries) {
    const { name, value } = parseEnvEntry(entry)
    const prior = merged.get(name)
    if (prior !== undefined && prior !== value) throw new Error(conflict(name))
    merged.set(name, value)
  }
  return [...merged].map(([name, value]) => ({ name, value }))
}
