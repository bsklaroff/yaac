// Unit tests are hermetic: they never touch podman or the cluster and
// their assertions assume a clean host environment. When the suite runs
// *inside* a yaac session (nested yaac), the session preset leaks
// YAAC_NESTED=1 and YAAC_K8S_REGISTRY into the process. Those flip
// environment-sensitive code paths — registryHost() returns the in-cluster
// per-project registry instead of localhost:5001, and createSession /
// runClusterCheck take their nested branches — which breaks otherwise
// deterministic unit assertions. Strip them so a unit run is identical on a
// developer host and inside a session.
//
// Only the `unit` project loads this file. E2e tests run the real CLI
// in-container and genuinely need the nested-session env (the daemon
// subprocess inherits it), so the shared test/setup.ts leaves it intact.
// Tests that exercise nested behavior set YAAC_NESTED themselves and clean
// up afterwards, so clearing the ambient default here is safe.
for (const key of ['YAAC_NESTED', 'YAAC_K8S_REGISTRY'] as const) {
  delete process.env[key]
}
