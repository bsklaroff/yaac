/**
 * A project's display name for a repo path: its last segment, lowercased,
 * other characters replaced by `-`, cut to 63 characters and trimmed to
 * alphanumerics at both ends. '' if nothing is left; the server refuses
 * that. Shared so the webapp can show the name before the project exists.
 */
export function projectNameFor(repoPath: string): string {
  return (repoPath.split('/').pop() ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .slice(0, 63)
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
}
