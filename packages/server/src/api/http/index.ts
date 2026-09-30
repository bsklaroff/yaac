// Public interface of the sealed http folder (`#http`): the middleware chain
// buildApp wires (CORS refusal, request log, Host/Origin/Sec-Fetch-Site
// guards, identity gate), the driver-feature gate routes call, the SPA static
// routes, and the thrown-value to wire-error conversion. Everything else in
// the folder is internal and tested through these.

export { denyBrowserCors, requestLogger } from './auth'
export { requireDriverFeature } from './driver-features'
export { toErrorBody } from './errors'
export { registerStaticRoutes } from './static'
export {
  fetchSiteCheck,
  hostHeaderCheck,
  identify,
  originHeaderCheck,
  type IdentityEnv,
} from './web-auth'
