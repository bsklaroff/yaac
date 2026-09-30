/**
 * The project slug for a repo path: its last segment, lowercased, other
 * characters replaced by `-`, cut to 63 characters and trimmed to
 * alphanumerics at both ends, so it is a valid Kubernetes label value
 * (`yaac.project`). '' if nothing is left; the server refuses that.
 * Shared so the webapp can predict the slug before the project exists.
 */
export function projectSlugFor(repoPath: string): string {
  return (repoPath.split('/').pop() ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .slice(0, 63)
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
}
