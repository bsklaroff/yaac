/**
 * Entrypoint for the activator Deployment (yaac-vc-activator): runs in
 * the proxy sidecar image with `tsx activator-main.ts` as the container
 * command. Separate from activator.ts so unit tests can import the
 * library without starting a listener.
 */

import { startActivator } from './activator'

const installNamespace = process.env.YAAC_INSTALL_NAMESPACE
if (!installNamespace) throw new Error('YAAC_INSTALL_NAMESPACE is required')

startActivator({
  port: Number(process.env.ACTIVATOR_PORT ?? '8443'),
  installNamespace,
})
