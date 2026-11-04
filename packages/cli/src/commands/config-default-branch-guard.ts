import { api, resolveProject } from '#commands/api'

/**
 * `yaac config default-branch-guard <project> [on|off]`: show or set
 * whether a hosted project refuses pushes that delete its default branch
 * or rewrite its history (docs/hosted-projects.md). A project hosted
 * elsewhere is protected at its git host, and the server refuses it here.
 */
export async function configDefaultBranchGuard(project: string, value: 'on' | 'off' | undefined): Promise<void> {
  const summary = await resolveProject(project)
  const { id: projectId, name } = summary
  const state = (on: boolean): string => (on ? 'refuses' : 'accepts')

  if (value === undefined) {
    console.log(summary.hosted === false
      ? `${name} is not hosted by yaac; its git host protects its branches.`
      : `${name} ${state(summary.guardDefaultBranch)} pushes that delete its default branch or rewrite its history.`)
    return
  }
  await api.project[':projectId']['default-branch-guard'].$put({ param: { projectId }, json: { enabled: value === 'on' } })
  console.log(`${name} now ${state(value === 'on')} pushes that delete its default branch or rewrite its history.`)
}
