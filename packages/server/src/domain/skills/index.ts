// The public interface of the skills feature. Everything outside this
// directory imports `#domain/skills`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// Two halves, three consumers. Worktree create stages yaac's own bundled
// skills and mounts them into the pod; server start refreshes the cache of
// Claude's binary-bundled skills; the projects route lists and details the
// skills a project's agent can see. `SKILL.md` parsing is internal to the
// feature — nothing outside it reads frontmatter — so it stays behind here
// and is covered through the entry points that use it.

export {
  builtinSkillMounts, builtinSkillsDir, reconcileSharedSkillRoots, sharedSkillRoots, stageBuiltinSkills,
} from './builtin'
export type { SkillDelivery } from './builtin'
export { refreshClaudeBundledSkills } from './claude-bundled'
export { getProjectSkills, getSkillDetail } from './discover'
