// Public interface of the sealed skills folder (`#domain/skills`), used by:
//  - workspace create, which stages yaac's built-in skills and mounts them;
//  - the projects route, which lists and shows a project's skills.
// `SKILL.md` parsing is internal.

export {
  builtinSkillMounts, builtinSkillsDir, reconcileSharedSkillRoots, sharedSkillRoots, stageBuiltinSkills,
} from './builtin'
export { getProjectSkills, getSkillDetail } from './discover'
