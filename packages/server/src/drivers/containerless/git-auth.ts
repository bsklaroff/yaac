import fs from 'node:fs/promises'
import path from 'node:path'
import { formatSshCommand } from '@yaac/shared/git'
import type { WorkspaceGitCredential } from '#drivers/contract'

/**
 * How a workspace's own git authenticates, on a substrate where the
 * credential it is handed is the real one.
 *
 * Nothing here is an optimization: a workspace handed no credential cannot
 * fetch or push at all. The checkout's `origin` is deliberately tokenless —
 * the clone strips it and every server-side call re-injects per invocation —
 * and the private HOME this driver gives a workspace hides the user's own
 * `~/.gitconfig` and `~/.ssh` from it. Under a pod neither matters, because
 * the egress proxy injects the credential in flight; there is no proxy here,
 * so the workspace has to hold it (docs/containerless-driver.md).
 *
 * HTTPS goes through git's own credential store rather than a token in a
 * remote URL: git worktrees share the repository's config, so a URL rewrite
 * would put the token in the server's mirror and in every sibling worktree.
 * The store's default file IS `$HOME/.git-credentials`, so the helper takes
 * no argument — no path has to survive gitconfig parsing and then a shell —
 * and the file is reaped with the worktree, since that HOME sits inside the
 * state dir teardown removes.
 *
 * SSH points ssh at the registered key with `-i`, where a pod gets the
 * proxy's forwarded agent: the key is a file on this host and the workspace
 * is a process on it, so there is nothing to forward it over. Host
 * verification still comes from the project-scoped known_hosts the server
 * wrote, so an unknown host key fails here exactly as it does in a pod.
 *
 * Tor is deliberately not routed, unlike the server's own git commands: a
 * containerless workspace has no egress path at all, so its agent's API
 * calls and package installs already go direct, and routing this one hop
 * would suggest a confinement that does not exist.
 */

/** The file `git credential-store` reads and writes by default, relative to
 *  the HOME the workspace runs with. */
const CREDENTIALS_FILE = '.git-credentials'

/**
 * The username half of an HTTPS credential. Any value works for a PAT, and
 * this is the one the server's own URL injection and the k8s proxy's header
 * both use — so what a workspace sends is what a pod would have sent.
 */
const HTTPS_USERNAME = 'x-access-token'

export interface WorkspaceGitAuth {
  /** Sections to append to the workspace's `.gitconfig`. */
  gitconfig: string[]
  /** Environment the tmux server holds, so every pane inherits it. */
  env: Record<string, string>
}

/**
 * Put the credential where the workspace's git will find it, and report what
 * the launch still has to say in the config and the environment.
 *
 * Safe to re-run: a relaunch after a failed attempt, and a restart after a
 * token was rotated, both land on the current answer.
 */
export async function realizeGitAuth(params: {
  home: string
  credential: WorkspaceGitCredential | undefined
  knownHostsFile: string | undefined
}): Promise<WorkspaceGitAuth> {
  const { home, credential, knownHostsFile } = params
  const store = path.join(home, CREDENTIALS_FILE)

  // Cleared before anything is written, which covers three cases with one
  // line: a project whose remote moved to SSH, a token rotated since the last
  // launch, and the file's mode — `writeFile` applies one only when it
  // creates, so re-creating is what keeps a secret at 0600.
  await fs.rm(store, { force: true })

  if (credential === undefined) return { gitconfig: [], env: {} }

  if (credential.kind === 'https') {
    await fs.writeFile(store, `${credentialStoreLine(credential)}\n`, { mode: 0o600 })
    // The empty value first is git's own way of resetting the helper list:
    // git consults every configured helper in order and takes the first
    // answer, so a host with a system-wide helper (a keychain, a manager)
    // would otherwise answer for this project with whatever the USER has
    // stored for that host, which is not the credential yaac resolved.
    return { gitconfig: ['[credential]', '\thelper =', '\thelper = store'], env: {} }
  }

  // Both halves of an SSH remote are decided together by the caller, so one
  // without the other is a wiring bug rather than a degraded worktree — and
  // the degraded worktree would be one that skips host verification.
  if (knownHostsFile === undefined) {
    throw new Error(
      'containerless: an SSH git credential arrived without a known_hosts file',
    )
  }
  return {
    gitconfig: [],
    env: {
      GIT_SSH_COMMAND: formatSshCommand([
        'ssh', '-F', '/dev/null',
        '-i', credential.privateKeyPath,
        '-o', `UserKnownHostsFile=${knownHostsFile}`,
        '-o', 'StrictHostKeyChecking=yes',
        '-o', 'IdentitiesOnly=yes',
      ]),
    },
  }
}

/**
 * One line of the credential store. Both halves are percent-encoded because
 * git url-decodes them on the way back in, and a token is opaque bytes that
 * may hold a reserved character.
 */
function credentialStoreLine(credential: { host: string; token: string }): string {
  const user = encodeURIComponent(HTTPS_USERNAME)
  return `https://${user}:${encodeURIComponent(credential.token)}@${credential.host}`
}
