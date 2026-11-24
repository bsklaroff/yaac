// Public interface of the sealed access folder (`#domain/access`): who may
// act on what. A caller is an `Actor`: a person, a delegate acting for one
// within limits, or the server. Domain verbs that make a user-caused write
// check it with `authorizeProject` against the project's owner at a level
// (`delegate` for the verbs an agent may call, `owner` for the rest), the
// few install-wide ones with `requireAdmin` (docs/multi-user.md
// "Authorization", "Roles"), and the few whose answer depends on state a
// person must judge with `requirePerson`. A delegate's ceiling is held by
// `requireWithinCeiling`, and a person's own id is read only through
// `personId`, which refuses a delegate.
//
// Each function added here needs a unit test in
// packages/server/test/domain/access/.

export {
  actorLabel,
  authorizeProject,
  isPerson,
  isProjectHeld,
  personId,
  requirePerson,
  requireWithinCeiling,
  systemPrincipal,
  withProjectsHeld,
  type AccessLevel,
  type Actor,
} from './authorize'
export { listInstallAdmins, replaceAdmins, requireAdmin, setUserRole } from './roles'
