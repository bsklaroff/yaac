import path from 'node:path'
import { getDataDir } from '@/shared/paths'
import { editFile } from '@/commands/edit-file'

export async function configEditUserDockerfile(): Promise<void> {
  await editFile(path.join(getDataDir(), 'Dockerfile.user'))
}
