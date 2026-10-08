/**
 * The Tailscale Kubernetes operator, whose Ingress publishes a `--tailnet`
 * or `--byo` server (server-fronting.ts, docs/remote-hosting.md).
 *
 * On kind yaac owns the cluster, so install puts the operator there itself
 * from Tailscale's static manifest, pinned by version and checksum like
 * Calico (pinned-manifest.ts), with images pinned by digest. It labels what
 * it applies and converges only an operator carrying that label. One
 * installed some other way (helm) is left to whoever installed it, and so
 * are its cluster-wide objects (the CRDs and the `tailscale` IngressClass):
 * install refuses rather than take those over. On a
 * `--byo` cluster the operator is the cluster owner's, and install only
 * checks that it is there.
 *
 * To upgrade, bump the version and image digests below and repin
 * k8s/tailscale-operator/operator.yaml.sha256 from the new manifest URL.
 * Rendering refuses a manifest that names an image with no digest here.
 */
import path from 'node:path'
import { parseAllDocuments } from 'yaml'
import {
  TAILSCALE_OPERATOR_NAMESPACE,
  applyObject,
  k8sErrorSummary,
  readObject,
  waitForRollout,
  type ObjectRef,
} from '#drivers/k8s/substrate'
import { TAILSCALE_OPERATOR_DIR } from '@yaac/shared/project-paths'
import { env } from '@yaac/shared/env'
import { ClusterInstallError } from './arg-guards'
import { ensurePinnedManifest } from './pinned-manifest'
import type { ClusterInstallDeps } from './install'

export const TAILSCALE_OPERATOR_VERSION = 'v1.102.4'

export function tailscaleOperatorManifestUrl(): string {
  return `https://raw.githubusercontent.com/tailscale/tailscale/${TAILSCALE_OPERATOR_VERSION}`
    + '/cmd/k8s-operator/deploy/manifests/operator.yaml'
}

/** The committed checksum of that manifest. */
export const TAILSCALE_OPERATOR_PIN_FILE = path.join(TAILSCALE_OPERATOR_DIR, 'operator.yaml.sha256')

/** Each image the manifest names, mapped to this version's digest. */
const TAILSCALE_OPERATOR_IMAGES: Record<string, string> = {
  'tailscale/k8s-operator:stable': `tailscale/k8s-operator:${TAILSCALE_OPERATOR_VERSION}@sha256:3c8958c42fb3c46068e8553e11b944f2133b4671d4f36c86adc11f206746bf34`,
  'tailscale/tailscale:stable': `tailscale/tailscale:${TAILSCALE_OPERATOR_VERSION}@sha256:2667499ed87ae29218f292556ba062918402dd5e92e93637af14867e4df12dd3`,
}

/** The Secret the operator reads its OAuth client from. */
const OAUTH_SECRET = 'operator-oauth'

/** Marks an operator install applied, which later installs converge. */
const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by'
const MANAGED_BY = 'yaac'

export type ManifestObject = Record<string, unknown> & {
  kind?: string
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }
}

interface OperatorContainer {
  image?: string
  env?: Array<{ name: string; value?: string | null }>
}

interface OperatorDeployment {
  spec: { template: { spec: { containers: OperatorContainer[]; initContainers?: OperatorContainer[] } } }
}

/**
 * The manifest's objects, ready to apply: the placeholder OAuth Secret
 * dropped (the caller writes the real one), every image (a container's, or
 * an `*_IMAGE` env value the operator launches) pinned by digest, and the
 * operator's own tailnet device named `hostname`. Null env values are
 * dropped, since a server-side apply reads a null as a field to remove.
 * Throws if an image has no digest in `TAILSCALE_OPERATOR_IMAGES`.
 */
export function tailscaleOperatorObjects(raw: string, hostname: string): ManifestObject[] {
  return parseAllDocuments(raw)
    .map((d) => d.toJS() as ManifestObject | null)
    .filter((d): d is ManifestObject => d !== null && typeof d === 'object')
    .filter((d) => !(d.kind === 'Secret' && d.metadata?.name === OAUTH_SECRET))
    .map((d) => {
      if (d.kind !== 'Deployment') return d
      const dep = structuredClone(d) as ManifestObject & OperatorDeployment
      const pod = dep.spec.template.spec
      for (const c of [...pod.containers, ...pod.initContainers ?? []]) {
        c.image = pinnedImage(c.image)
        c.env = c.env?.filter((e) => e.value !== null).map((e) => (
          e.name === 'OPERATOR_HOSTNAME' ? { ...e, value: hostname }
            : e.name.endsWith('_IMAGE') ? { ...e, value: pinnedImage(e.value ?? undefined) }
              : e))
      }
      return dep
    })
}

function pinnedImage(ref: string | undefined): string {
  const pinned = ref === undefined ? undefined : TAILSCALE_OPERATOR_IMAGES[ref]
  if (pinned) return pinned
  throw new ClusterInstallError(
    `The Tailscale operator ${TAILSCALE_OPERATOR_VERSION} manifest names the image ${ref ?? '(none)'}, `
    + 'which has no pinned digest. Add it to TAILSCALE_OPERATOR_IMAGES (install/tailscale-operator.ts).',
  )
}

/** The operator's OAuth Secret, from the client `TS_OAUTH_CLIENT_*` names. */
export function tailscaleOperatorOauthSecret(client: { id: string; secret: string }): ManifestObject {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: OAUTH_SECRET, namespace: TAILSCALE_OPERATOR_NAMESPACE },
    stringData: { client_id: client.id, client_secret: client.secret },
  }
}

const OPERATOR_DEPLOYMENT: ObjectRef = {
  apiVersion: 'apps/v1', kind: 'Deployment', name: 'operator', namespace: TAILSCALE_OPERATOR_NAMESPACE,
}

/**
 * The objects that say an operator is installed: its Deployment, and the
 * cluster-wide CRD and IngressClass any operator in the cluster shares.
 */
const OPERATOR_OBJECTS: Array<[string, ObjectRef]> = [
  ['the ProxyClass CRD (proxyclasses.tailscale.com)', {
    apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', name: 'proxyclasses.tailscale.com',
  }],
  [`the operator Deployment (${TAILSCALE_OPERATOR_NAMESPACE}/operator)`, OPERATOR_DEPLOYMENT],
  ['the operator\'s IngressClass (tailscale)', {
    apiVersion: 'networking.k8s.io/v1', kind: 'IngressClass', name: 'tailscale',
  }],
]

/** A failed read of the operator, as the refusal that names the real fix. */
function unevaluated(flag: string, what: string, err: unknown): ClusterInstallError {
  return new ClusterInstallError(
    `${flag} needs the Tailscale Kubernetes operator, and whether it is installed could not `
    + `be evaluated: reading ${what} failed (${k8sErrorSummary(err)}).\n`
    + '    Fix the cluster access (kubeconfig, apiserver) and re-run.',
  )
}

/**
 * `--tailnet` on kind: install the operator when the cluster lacks it, or
 * converge the one an earlier install put there, then verify it. Installing
 * needs the OAuth client from `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_CLIENT_SECRET`;
 * converging reuses the Secret already in the cluster unless one is given.
 *
 * An operator Deployment without the yaac label is someone else's, so it is
 * only verified. Without that Deployment, a CRD or IngressClass lacking the
 * label belongs to an operator elsewhere (another namespace) or to a
 * half-removed one; applying would take it over, so install refuses.
 */
export async function ensureTailnetOperator(deps: ClusterInstallDeps): Promise<void> {
  const foreign: ObjectRef[] = []
  let deployment: ManifestObject | null = null
  for (const [what, ref] of OPERATOR_OBJECTS) {
    let found: ManifestObject | null
    try {
      found = await readObject<ManifestObject>(ref)
    } catch (err) {
      throw unevaluated('--tailnet', what, err)
    }
    if (ref === OPERATOR_DEPLOYMENT) deployment = found
    if (found && found.metadata?.labels?.[MANAGED_BY_LABEL] !== MANAGED_BY) foreign.push(ref)
  }
  if (foreign.includes(OPERATOR_DEPLOYMENT)) {
    await verifyTailnetOperator(deps)
    return
  }
  if (foreign.length > 0) {
    const named = OPERATOR_OBJECTS.filter(([, ref]) => foreign.includes(ref)).map(([what]) => what)
    throw new ClusterInstallError(
      `--tailnet would install the Tailscale operator, but ${named.join(' and ')} `
      + `${named.length > 1 ? 'are' : 'is'} already in this cluster, put there by something other than `
      + 'yaac. That is an operator installed some other way (helm, perhaps into another namespace) '
      + 'or a half-removed one, and installing would take its cluster-wide objects over. Finish that '
      + `install in the ${TAILSCALE_OPERATOR_NAMESPACE} namespace, or remove it completely (its CRDs and `
      + 'IngressClass too), then re-run.',
    )
  }
  const client = env.tailscaleOauthClient
  if (!deployment && !client) {
    throw new ClusterInstallError(
      '--tailnet publishes the server through the Tailscale Kubernetes operator, which this '
      + 'cluster lacks. Install sets it up given an OAuth client: create one in the Tailscale '
      + 'admin console as https://tailscale.com/kb/1236/kubernetes-operator describes (its '
      + 'scopes, the tag:k8s-operator tag, and the tagOwners entries), then re-run with it exported:\n'
      + '      TS_OAUTH_CLIENT_ID=<id> TS_OAUTH_CLIENT_SECRET=<secret> yaac cluster install --tailnet\n'
      + '    Or, with no operator, publish the server through this machine\'s own `tailscale serve`: '
      + 'yaac cluster install --tailnet <this machine\'s MagicDNS name>.',
    )
  }
  const raw = await ensurePinnedManifest(deps, {
    what: 'Tailscale operator',
    url: tailscaleOperatorManifestUrl(),
    pinFile: TAILSCALE_OPERATOR_PIN_FILE,
    cacheName: `tailscale-operator-${TAILSCALE_OPERATOR_VERSION}.yaml`,
  })
  deps.log(`Installing the Tailscale operator ${TAILSCALE_OPERATOR_VERSION}...`)
  const objects = [
    ...tailscaleOperatorObjects(raw, `${env.kindCluster}-operator`),
    ...client ? [tailscaleOperatorOauthSecret(client)] : [],
  ]
  for (const obj of objects) {
    await applyObject({
      ...obj,
      metadata: { ...obj.metadata, labels: { ...obj.metadata?.labels, [MANAGED_BY_LABEL]: MANAGED_BY } },
    })
  }
  await waitForRollout({ workload: 'deployment/operator', namespace: TAILSCALE_OPERATOR_NAMESPACE, timeoutMs: 300_000 })
  await verifyTailnetOperator(deps)
}

/**
 * Check that the operator is installed, or the server's Ingress never gets
 * a hostname. A failed read is reported separately from a missing object,
 * since they need different fixes.
 */
export async function verifyTailnetOperator(deps: ClusterInstallDeps, flag = '--tailnet'): Promise<void> {
  deps.log(`Verifying the Tailscale Kubernetes operator (${flag})...`)
  for (const [what, ref] of OPERATOR_OBJECTS) {
    let found: unknown
    try {
      found = await readObject(ref)
    } catch (err) {
      throw unevaluated(flag, what, err)
    }
    if (!found) {
      throw new ClusterInstallError(
        `${flag} needs the Tailscale Kubernetes operator, and ${what} is not in this cluster.\n`
        + '    Install it (an OAuth client with the tag its proxies use — see '
        + 'https://tailscale.com/kb/1236/kubernetes-operator), then re-run:\n'
        + '      helm repo add tailscale https://pkgs.tailscale.com/helmcharts\n'
        + '      helm upgrade --install tailscale-operator tailscale/tailscale-operator \\\n'
        + `        --namespace=${TAILSCALE_OPERATOR_NAMESPACE} --create-namespace \\\n`
        + '        --set-string oauth.clientId=<id> --set-string oauth.clientSecret=<secret> --wait',
      )
    }
  }
  deps.log('  Tailscale operator present: the server will be published on the tailnet.')
}
