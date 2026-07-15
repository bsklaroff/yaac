import { api } from './api'
import type { AgentTool, ProjectSkills, SkillDetail } from '@yaac/shared/types'

/** The personal + plugin + project skills the project's agent can use. `branch`
 *  selects the origin branch project (repo) skills are read from. */
export async function getProjectSkills(
  slug: string,
  tool: AgentTool = 'claude',
  branch?: string,
): Promise<ProjectSkills> {
  return api.project[':slug'].skills.$get({ param: { slug }, query: { tool, ...(branch ? { branch } : {}) } })
}

/** The full SKILL.md for one skill, fetched on demand when a row is expanded. */
export async function getSkillBody(
  slug: string,
  id: string,
  tool: AgentTool = 'claude',
  branch?: string,
): Promise<SkillDetail> {
  return api.project[':slug'].skills.body.$get({
    param: { slug },
    query: { id, tool, ...(branch ? { branch } : {}) },
  })
}
