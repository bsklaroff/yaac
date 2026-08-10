// The public interface of the projects feature: the lifecycle verbs and the
// row-backed answers to "which projects exist" — add, detail, list, and the
// config resolution that must first prove the project is real. The disk
// half of a project (the clone, its config files, its credentials, its
// build context) is `#store/projects`. Everything outside this directory
// imports `#features/projects`; the SEALED_FOLDERS lint rule stops src from
// reaching past this file. Adding a name here widens the interface and
// obliges a unit test in packages/server/test/features/projects/.

export { addProject } from './add'
export { assertProjectExists, getProjectDetail, resolveProjectConfigWithSource } from './detail'
export { listProjects } from './list'
