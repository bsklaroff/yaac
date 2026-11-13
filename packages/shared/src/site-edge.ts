/**
 * Which edge publishes a site (docs/public-sites.md "Tailnet sites"). A
 * hostname under the install's site domain is a tailnet site's, served
 * only to the install's tailnet; any other is public, served through the
 * Cloudflare tunnel. The hostname alone decides, so the server, the CLI
 * and the webapp all derive it here.
 */
import type { SiteEdge } from './types'

export function siteEdgeOf(hostname: string, siteDomain: string | undefined): SiteEdge {
  return siteDomain !== undefined && hostname.toLowerCase().endsWith(`.${siteDomain}`) ? 'tailnet' : 'public'
}
