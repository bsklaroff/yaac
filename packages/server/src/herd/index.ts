/**
 * The boundary between the server and its herd (docs/plans/herd-split.md).
 *
 * `contract.ts` is the whole of what the server may ask a herd to do;
 * `in-process.ts` is the implementation that calls today's functions, and the
 * ONE module under `packages/server/src` allowed to import the herd's
 * features. The `SERVER_SRC` lint zone in eslint.config.js is what keeps it
 * that way, so the day a herd is a child process the swap is one line in the
 * server's startup.
 *
 * The mirror direction — what a herd reports back — is `#server-link`, at the
 * package root for the same reason `#notify` is: its callers are spread
 * across the herd's features and none of them may depend on the server.
 *
 * Only the whole client is named here. The per-group interfaces live in
 * `contract.ts` and are reached through it (`HerdClient['workspaces']`),
 * because a caller wants one method, not a group.
 */

export { DESIRED_SET_TRIGGERS } from './contract'
export type { HerdChangeSource, HerdClient, WorkspaceHandle } from './contract'
export {
  _resetHerdForTests,
  _setHerdForTests,
  herd,
  setHerd,
  type HerdStub,
} from './current'
export { createInProcessHerd } from './in-process'
