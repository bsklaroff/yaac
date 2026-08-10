// The public interface of the auth feature. Everything outside this
// directory imports `#domain/auth`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// Two consumers. The auth routes read the masked credential list, clear
// stored credentials, nudge the plan-usage refresh, and drive the vendor
// sign-in flows through the relay hub (whose WebSocket the server's upgrade
// handler also holds); the snapshot builder reads the two plan-usage slices.
//
// Everything behind those names is internal: the usage and profile
// endpoints, both OAuth refresh grants, and the masking. They are reached
// only through the entry points above and are covered through them.

export { authAgentHub } from './agent'
export { clearAuth } from './clear'
export { listAuth } from './list'
export {
  codexPlanUsageForSnapshot,
  planUsageForSnapshot,
  requestPlanUsageRefresh,
} from './plan-usage'
