// The public interface of the container platform folder. Everything outside
// this directory imports `#platform/container`; the SEALED_FOLDERS lint rule
// stops src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// Three modules, one per job the host's container engine does. port.ts hands
// out host TCP ports that stay bound from discovery to use and turns them into
// forwarders that spawn a caller-supplied relay per connection — session port
// forwards and the proxy control API are the two relays. runtime.ts is the
// host side of the split runtime: the once-per-process check that podman (the
// image build engine) and kubernetes (the session runtime) are both usable,
// the CONTAINER_HOST lever that points every podman call at the rootful
// engine, and the two image-store queries the image and cluster features make.
// registry.ts is the local OCI registry — a podman container and an HTTP
// endpoint that the image builders, the proxy client and server start push to.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/platform/container/. What is not re-exported — the
// bind loop, the per-connection relay plumbing, the platform-specific podman
// install instructions, the registry's readiness wait — is internal, and
// covered through the entry points below.

export { reserveAvailablePort, startPortForwarders, type RelayFactory, type ReservedPort } from './port'
export {
  ensureLocalRegistry,
  pushImageToRegistry,
  registryHasTag,
  registryHost,
  registryReachable,
  registryRef,
  REGISTRY_CONTAINER_NAME,
  removeLocalRegistry,
} from './registry'
export {
  ensureContainerRuntime,
  ensureRootfulPodmanHost,
  execFileAsync,
  imageExists,
  removeImage,
  ROOTFUL_PODMAN_SOCKET,
} from './runtime'
