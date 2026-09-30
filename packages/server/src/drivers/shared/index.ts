// Code shared by the drivers and used by nothing else. Drivers cannot import
// each other, so this is where common substrate code lives instead of
// being duplicated or pushed up into `#lib`. It may not import a driver,
// `#db`, `#domain` or `#runtime` (enforced by lint).
//
// Used by both drivers only → here. Also used above the drivers → `#lib`
// or `@yaac/shared`. One driver only → that driver's folder.
//
// Each name exported here needs a unit test in
// packages/server/test/drivers/shared/.

// The review diff: the in-workspace script and the parser for its output.
export {
  buildChangesScript,
  parseChangesOutput,
  type ChangesLocation,
} from './workspace-changes'
