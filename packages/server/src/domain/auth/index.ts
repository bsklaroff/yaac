// Public interface of the sealed auth folder (`#domain/auth`). Every
// credential here is a user's; callers name the owner (a route's caller, or
// a project's owner):
//  - the auth routes: masked credential list, sign-in and clearing,
//    plan-usage refresh, and vendor sign-in via the per-user relay hub
//    (whose WebSocket the server's upgrade handler also holds);
//  - the create path and `yaac-mama`: a user's sign-in for a tool, and the
//    owner key their workspaces' egress registrations name;
//  - the snapshot builder: the plan-usage slices, by user;
//  - credential sync: create seeds a project's tool homes, startup re-seeds
//    them under a mediating runtime, and the reconcile pass (plus
//    containerless attach and workspace stop) runs the periodic sweep;
//  - the model catalog, for the create path and `yaac-mama models`;
//  - the runtime link: every writer of a store pushes every user's set to
//    the runtime, each under its owner key, and the reconcile pass adopts
//    tokens a mediating runtime captured from a workspace's refresh;
//  - startup's one-shot import of the pre-database credential files.
// Usage/profile endpoints, OAuth refresh grants and masking are internal.

export { authAgentHub } from './agent'
export { clearAuth } from './clear'
export {
  harvestToolCredentials,
  reseedPlaceholderToolHomes,
  runtimeMediatesEgress,
  seedProjectToolHome,
  syncToolCredentials,
} from './credential-sync'
export { importToolCredentialFiles } from './import-files'
export { listAuth } from './list'
export { catalogModel, defaultModelFor, isCatalogModel, modelDisplayName, modelEfforts, modelsForTool } from './models'
export { adoptRefreshedToolCredentials, pushCredentialsToRuntime } from './runtime-push'
export { signInTool } from './sign-in'
export { credentialOwnerKey, loadToolAuthEntry } from './store'
export {
  planUsageForSnapshot,
  refreshPlanUsage,
  requestPlanUsageRefresh,
} from './plan-usage'
