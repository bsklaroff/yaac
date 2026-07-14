import { api } from './api'
import type { AgentTool, ProjectSkills, SkillDetail } from '@yaac/shared/types'

/** The personal + plugin + project skills the project's agent can use. */
export async function getProjectSkills(slug: string, tool: AgentTool = 'claude'): Promise<ProjectSkills> {
  return api.project[':slug'].skills.$get({ param: { slug }, query: { tool } })
}

/** The full SKILL.md for one skill, fetched on demand when a row is expanded. */
export async function getSkillBody(slug: string, id: string, tool: AgentTool = 'claude'): Promise<SkillDetail> {
  return api.project[':slug'].skills.body.$get({ param: { slug }, query: { id, tool } })
}
