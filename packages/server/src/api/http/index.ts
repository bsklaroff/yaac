// The public interface of the http layer. Everything outside this directory
// imports `#http`; the SEALED_FOLDERS lint rule stops src from reaching past
// this file. Modules in here import each other by relative path, which is why
// they are unaffected by that rule.
//
// This is what the server's assembly needs: the middleware chain buildApp
// wires (CORS refusal, request log, Host/Origin/Sec-Fetch-Site guards and the
// one credential gate), the SPA static routes, the thrown-value→wire-error
// conversion every route's error handler calls, and the token store plus its
// two persistence calls.
//
// Everything behind those names is internal: the public-path table, the
// host/origin/fetch-site predicates the middleware wrap, the deployment
// posture check, the constant-time compare, the MIME table and the CSP
// builder. They are reached only through the entry points below and are
// covered through them.

export { denyBrowserCors, requestLogger } from './auth'
export { requireDriverFeature, type DriverFeature } from './driver-features'
export { toErrorBody } from './errors'
export { registerStaticRoutes } from './static'
export { createTokenStore, loadTokens, saveTokens, type TokenStore } from './token-store'
export {
  cookieOrBearerAuth,
  fetchSiteCheck,
  hostHeaderCheck,
  isCredentialOptional,
  originHeaderCheck,
  sessionCookieName,
} from './web-auth'
