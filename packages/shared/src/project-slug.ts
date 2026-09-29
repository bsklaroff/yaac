/**
 * The project slug a remote's repo path derives: its last segment,
 * lowercased, with anything outside `[a-z0-9._-]` made a `-`, cut to 63
 * characters and trimmed to alphanumerics at both ends — a valid Kubernetes
 * label value, since the slug is stamped on every pod of the project
 * (`yaac.project`). An ordinary repo name passes through unchanged but for
 * case. '' when nothing is left, which the server refuses.
 *
 * Shared because the webapp names things after the project before it
 * exists (a credential's default name), and must agree with the server.
 */
export function projectSlugFor(repoPath: string): string {
  return (repoPath.split('/').pop() ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .slice(0, 63)
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
}
