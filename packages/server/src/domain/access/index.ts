// Public interface of the sealed access folder (`#domain/access`): who may
// act on what. Domain verbs that make a user-caused write take the caller's
// `Actor` and check it with `authorizeProject` against the project's owner,
// and the few install-wide ones with `requireAdmin` (docs/multi-user.md
// "Authorization", "Roles").
//
// Each function added here needs a unit test in
// packages/server/test/domain/access/.

export {
  authorizeProject,
  isProjectHeld,
  systemPrincipal,
  withProjectsHeld,
  workspacePrincipal,
  type AccessLevel,
  type Actor,
} from './authorize'
export { listInstallAdmins, replaceAdmins, requireAdmin, setUserRole } from './roles'
