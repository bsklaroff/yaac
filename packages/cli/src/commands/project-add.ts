import { api, resolveGitCredentialId } from '#commands/api'
import { upstreamTarget } from '#commands/repo'

/** How a remote is added (docs/repo-forks.md). */
export interface RepoAddFlags {
  /** Workspaces only read it. */
  readOnly?: boolean
  /** yaac hosts a fork of it, which workspaces push to. */
  fork?: boolean
  /** Its upstream: one of your repos, or a remote URL. */
  upstream?: string
  /** The credential the upstream's remote is read with. */
  upstreamCredential?: string
}

/** The add fields `RepoAddFlags` and a credential name stand for. */
export async function repoAddFields(credential: string | undefined, flags: RepoAddFlags): Promise<{
  credentialId?: string
  readOnly?: boolean
  fork?: boolean
  upstream?: Awaited<ReturnType<typeof upstreamTarget>>
}> {
  return {
    ...(credential !== undefined ? { credentialId: await resolveGitCredentialId(credential) } : {}),
    ...(flags.readOnly === true ? { readOnly: true } : {}),
    ...(flags.fork === true ? { fork: true } : {}),
    ...(flags.upstream !== undefined ? { upstream: await upstreamTarget(flags.upstream, flags.upstreamCredential) } : {}),
  }
}

/** What an add answers beyond the repo itself, said the same way by both
 *  adds. */
export function printAddNotes(result: { knownHostsEntry: string | null; allowedHost: string | null; suggestedUpstream?: string }, repoRef: string): void {
  if (result.knownHostsEntry !== null) console.log(`Host key trusted: ${result.knownHostsEntry}`)
  if (result.allowedHost !== null) {
    console.log(`Added ${result.allowedHost} to the project's egress allowlist, so its workspaces can reach the repo.`)
  }
  if (result.suggestedUpstream !== undefined) {
    console.log(`GitHub says this repo is a fork of ${result.suggestedUpstream}. To fetch its history as upstream/*, run `
      + `\`yaac repo upstream ${repoRef} ${result.suggestedUpstream}\`.`)
  }
}

/**
 * `yaac project add`: a project around a remote, cloned with the named
 * credential (optional with --fork or --read-only, which read it
 * anonymously), or around one of your repos by id.
 */
export async function projectAdd(
  input: string | undefined,
  credentialName: string | undefined,
  opts: RepoAddFlags & { repoId?: string } = {},
): Promise<void> {
  if ((input === undefined) === (opts.repoId === undefined)) throw new Error('Give a <remote-url>, or --repo-id <id>.')
  console.log(`Adding project from ${input ?? opts.repoId}...`)
  const result = opts.repoId !== undefined
    ? await api.project.add.$post({ json: { repoId: opts.repoId } })
    : await (async () => {
      const { credentialId, ...rest } = await repoAddFields(credentialName, opts)
      return api.project.add.$post({
        json: { remoteUrl: input ?? '', ...(credentialId !== undefined ? { gitCredentialId: credentialId } : {}), ...rest },
      })
    })()
  console.log(`Project "${result.project.name}" (${result.project.id}) added successfully.`)
  printAddNotes(result, `${result.project.name}/${result.project.name}`)
}
