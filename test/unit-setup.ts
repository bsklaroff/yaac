// Unit tests are hermetic: they never touch podman or the cluster and
// their assertions assume a clean host environment. When the suite runs
// *inside* a yaac session (nested yaac), the session preset leaks
// YAAC_NESTED=1, YAAC_DATA_DIR, and YAAC_K8S_REGISTRY into the process.
// Those flip environment-sensitive code paths — registryHost() returns the
// in-cluster per-project registry instead of localhost:5001, createSession /
// runClusterCheck take their nested branches, and getDataDir() resolves to
// the session's node-shared virtiofs data dir (slow, coarse file
// timestamps) for any test that doesn't set its own — which breaks
// otherwise deterministic unit assertions. Strip them so a unit run is
// identical on a developer host and inside a session; each test sets its
// own data dir via setDataDir / createTempDataDir.
//
// Only the `unit` project loads this file. E2e tests run the real CLI
// in-container and genuinely need the nested-session env (the daemon
// subprocess inherits it), so the shared test/setup.ts leaves it intact.
// Tests that exercise nested behavior set YAAC_NESTED themselves and clean
// up afterwards, so clearing the ambient default here is safe.
for (const key of ['YAAC_NESTED', 'YAAC_DATA_DIR', 'YAAC_K8S_REGISTRY'] as const) {
  delete process.env[key]
}
