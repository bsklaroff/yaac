/**
 * URLs of a yaac-hosted project's remote (docs/hosted-projects.md). Free of
 * imports so the webapp can build them too.
 */

/**
 * Where a workspace's git reaches a hosted remote, on either driver: the
 * egress proxy relays `yaac.internal` to the server under k8s, and a
 * containerless workspace's gitconfig rewrites it to the server's loopback
 * origin. It is the project row's `remoteUrl`, so every checkout's `origin`
 * is this URL.
 */
export const HOSTED_REMOTE_PREFIX = 'http://yaac.internal/api/workspace/git/'

export function hostedRemoteUrl(projectId: string): string {
  return `${HOSTED_REMOTE_PREFIX}${projectId}.git`
}

/** Where the user's own git clones and pushes a hosted project, on the
 *  server's API origin. */
export function hostedCloneUrl(serverOrigin: string, projectId: string): string {
  return `${serverOrigin.replace(/\/+$/, '')}/api/project/${projectId}/git`
}
