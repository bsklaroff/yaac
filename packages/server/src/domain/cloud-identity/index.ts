// Public interface of the sealed cloud-identity folder
// (`#domain/cloud-identity`): the cloud identity a project's workspaces act
// as (docs/cloud-identity.md). The composition root starts the token
// refresh; the routes read what the server found and set a project's
// identity. Each cloud's provider is internal.
//
// Each function added here needs a unit test in
// packages/server/test/domain/cloud-identity/.

export { assignProjectCloudIdentity, cloudIdentityInfo, startCloudIdentity } from './identity'
