// Public interface of the sealed access folder (`#domain/access`): who may
// act on what. Domain verbs that make a user-caused write take the caller's
// `Actor` and check it with `authorizeProject` against the project's owner
// (docs/plans/multi-user-deployment.md "Authorization").
//
// Each function added here needs a unit test in
// packages/server/test/domain/access/.

export {
  authorize,
  authorizeProject,
  systemPrincipal,
  workspacePrincipal,
  type AccessLevel,
  type Actor,
  type Owned,
} from './authorize'
