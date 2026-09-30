// Public interface of the sealed auth folder (`#domain/auth`):
//  - the auth routes: masked credential list, clearing credentials,
//    plan-usage refresh, and vendor sign-in via the relay hub (whose
//    WebSocket the server's upgrade handler also holds);
//  - the snapshot builder: the two plan-usage slices;
//  - credential sync: create seeds a project's tool homes, the auth route
//    fans a new login out to them, and the reconcile pass (plus containerless
//    attach and workspace stop) runs the periodic sweep;
//  - the model catalog, for the create path and `yaac-mama models`;
//  - the runtime link: every writer of the host store pushes the full set to
//    the runtime, and the reconcile pass adopts tokens a mediating runtime
//    captured from a workspace's refresh.
// Usage/profile endpoints, OAuth refresh grants and masking are internal.

export { authAgentHub } from './agent'
export { clearAuth } from './clear'
export {
  fanOutToolCredentials,
  harvestToolCredentials,
  runtimeMediatesEgress,
  seedProjectToolHome,
  syncToolCredentialsThrottled,
} from './credential-sync'
export { listAuth } from './list'
export { catalogModel, defaultModelFor, modelDisplayName, modelsForTool } from './models'
export { adoptRefreshedToolCredentials, pushCredentialsToRuntime } from './runtime-push'
export {
  codexPlanUsageForSnapshot,
  planUsageForSnapshot,
  refreshPlanUsage,
  requestPlanUsageRefresh,
} from './plan-usage'
