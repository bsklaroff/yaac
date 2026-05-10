import path from 'node:path'
import { getRpcClient, toClientError } from '@/commands/rpc'
import { projectConfigDir } from '@/shared/paths'
import { editFile } from '@/commands/edit-file'

export async function configEdit(projectSlug: string): Promise<void> {
  const client = await getRpcClient()
  const res = await client.project[':slug'].$get({ param: { slug: projectSlug } })
  if (!res.ok) throw await toClientError(res)

  await editFile(path.join(projectConfigDir(projectSlug), 'yaac-config.json'))
}
