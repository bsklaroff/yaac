import { spawn } from 'node:child_process'
import { projectRepoOf, resolveProject } from '#commands/api'
import { resolveServerTarget } from '@yaac/shared/server-api'
import { hostedCloneUrl } from '@yaac/shared/hosted-git'

/**
 * Clone a project's hosted repo from the server into `dir` (default: the
 * project's name, or the repo's folder in a project with several), so its
 * code can be read and pushed from this machine. `--repo` names the repo
 * of a project with several.
 */
export async function projectClone(project: string, dir: string | undefined, opts: { repo?: string } = {}): Promise<void> {
  const summary = await resolveProject(project)
  const repo = projectRepoOf(summary, opts.repo)
  if (!repo.hosted) {
    throw new Error(`${repo.dir} of project "${summary.name}" is not hosted by yaac; clone it from ${repo.remoteUrl}.`)
  }
  const { baseUrl } = await resolveServerTarget()
  const into = dir ?? (summary.repos.length > 1 ? repo.dir : summary.name)
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn('git', ['clone', hostedCloneUrl(baseUrl, repo.id), into], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', resolve)
  })
  if (code !== 0) throw new Error(`git clone exited with ${String(code)}`)
}
