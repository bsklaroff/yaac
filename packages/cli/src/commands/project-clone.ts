import { spawn } from 'node:child_process'
import { api } from '#commands/api'
import { resolveServerTarget } from '@yaac/shared/server-api'
import { hostedCloneUrl } from '@yaac/shared/hosted-git'

/**
 * Clone a hosted project's remote from the server into `dir` (default: the
 * project's name), so its code can be read and pushed from this machine.
 */
export async function projectClone(project: string, dir?: string): Promise<void> {
  const detail = await api.project[':projectId'].$get({ param: { projectId: project } })
  if (!detail.hosted) {
    throw new Error(`Project "${detail.name}" is not hosted by yaac; clone it from ${detail.remoteUrl}.`)
  }
  const { baseUrl } = await resolveServerTarget()
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn('git', ['clone', hostedCloneUrl(baseUrl, detail.id), dir ?? detail.name], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', resolve)
  })
  if (code !== 0) throw new Error(`git clone exited with ${String(code)}`)
}
