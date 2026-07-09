import path from 'node:path'
import { getRpcClient, toClientError } from '@/commands/rpc'
import { getDataDir, projectConfigDir } from '@/shared/paths'
import { editFile } from '@/commands/edit-file'

/**
 * Open one of a project's per-machine config files (`yaac-config.json`,
 * `Dockerfile.yaac`) in $EDITOR, after verifying the project exists via
 * the daemon.
 */
export async function editProjectConfigFile(projectSlug: string, filename: string): Promise<void> {
  const client = await getRpcClient()
  const res = await client.project[':slug'].exists.$get({ param: { slug: projectSlug } })
  if (!res.ok) throw await toClientError(res)

  await editFile(path.join(projectConfigDir(projectSlug), filename))
}

/**
 * Open the global (all-projects) `~/.yaac/Dockerfile.user` in $EDITOR.
 * No daemon round-trip: the file is not project-scoped.
 */
export async function configEditUserDockerfile(): Promise<void> {
  await editFile(path.join(getDataDir(), 'Dockerfile.user'))
}
