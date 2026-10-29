/**
 * The install's npm cache: one Verdaccio that workspace pods install through
 * (docs/workspace-storage.md, "Package installs"). Each workspace has its own
 * pnpm store, so installs are usually cold; this fetches each package from
 * npmjs once per cluster and keeps working when npmjs is slow or down. It is
 * deployed like the crates.io cache (package-cache.ts).
 *
 * An nginx sidecar owns the cache port and caches Verdaccio's metadata
 * answers on pod-local disk. Verdaccio is one Node event loop that reads and
 * parses a package's whole metadata document on every request, and some
 * documents run to tens of MB, so many workspaces installing at once can
 * starve it. nginx collapses concurrent identical requests into one, serves
 * repeats from disk, and keeps serving a stale copy while it refreshes.
 *
 * Workspaces cannot publish (the cache is shared across projects), and pnpm
 * verifies every tarball against the lockfile. It is only the default
 * registry: a project's own `.npmrc` wins, and those requests go through the
 * egress proxy. The cache sends no credentials upstream. Only pods labelled
 * `LABEL_NPM_CACHE` at launch (npmCache on, npmjs allowed, no proxied npmjs
 * secret) can reach it.
 *
 * Nothing prunes the cache yet.
 */
import { prebuiltRef } from './registry'
import { NGINX_MIRROR_TAG, NPM_CACHE, cacheNginxContainer, cacheUrl, ensurePackageCache } from './package-cache'

/** Digest-pinned (multi-arch index) and mirrored like Envoy (netd.ts). */
const VERDACCIO_VERSION = '6.10.4'
const VERDACCIO_PIN = 'sha256:43c4067288b050422265407ea2fe747e511fcd0c407a85ec90ab9a326d9400cd'
export const VERDACCIO_UPSTREAM_IMAGE = `docker.io/verdaccio/verdaccio@${VERDACCIO_PIN}`
export const VERDACCIO_MIRROR_TAG =
  `verdaccio/verdaccio:${VERDACCIO_VERSION}-${VERDACCIO_PIN.slice('sha256:'.length, 'sha256:'.length + 12)}`

/** Where Verdaccio listens: loopback only, so nothing bypasses nginx. */
const VERDACCIO_PORT = 4874

/** Verdaccio's memory limit. The V8 heap is capped at three quarters of it,
 *  so V8 collects harder before the cgroup limit and leaves room for the
 *  off-heap Buffers holding response bodies. Hitting either limit still
 *  restarts Verdaccio. */
const VERDACCIO_MEMORY_MIB = 4096

/** The group the image's `verdaccio` user runs as (uid 10001, `nogroup`). */
const VERDACCIO_GID = 65533

/**
 * nginx's server block, included inside the image's `http {}`. Package
 * metadata is cached. Tarballs are passed through: Verdaccio streams them
 * from its claim without parsing, so a second copy here would cost disk for
 * little CPU. Its `/-/` API (ping, search, audit) is passed through too, so
 * the readiness probe reaches Verdaccio itself.
 *
 * The key includes Accept because npm and pnpm ask for the abbreviated
 * document at the same URL as the full one. Metadata is kept five minutes,
 * as npmjs's own CDN does, so new versions appear but no install outlasts
 * it. Upstream gzip is cached as is and inflated only for a client that
 * cannot take it.
 *
 * Pass-through responses stream through memory buffers rather than spool to
 * the container's disk (`proxy_max_temp_file_size 0`; cached ones are not
 * subject to it). Past `max_size`, or when the node's disk has under
 * `min_free` left, nginx evicts least-recently-used entries. A cache write that hits a full disk
 * sends the client a truncated body, so the cache sheds itself well before
 * that.
 *
 * Verdaccio answers 404 for npm's signing keys and attestations, so nginx
 * fetches those two from npmjs itself. Without the keys, `pnpm audit
 * signatures` finds no keys for this registry, checks nothing, and still
 * reports success. The certificate is verified, since keys from anyone else
 * would make that audit vouch for their packages. Only GET and HEAD go out,
 * and no client's `Authorization` or `Cookie` header does (Verdaccio has no
 * users, so it needs neither). The host is resolved per
 * request through the pod's DNS server, which the image's entrypoint
 * substitutes into this template, so nginx still starts when DNS is down.
 * IPv6 is off because the egress policy allows IPv4 only.
 */
function buildNpmCacheNginxConf(): string {
  return `proxy_cache_path /var/cache/npm levels=1:2 keys_zone=npm:10m max_size=1g min_free=2g inactive=1d use_temp_path=off;
log_format npm_cache '$remote_addr "$request" $status $body_bytes_sent $upstream_cache_status $request_time';
resolver \${NGINX_LOCAL_RESOLVERS} ipv6=off valid=60s;
upstream verdaccio {
  server 127.0.0.1:${VERDACCIO_PORT};
  keepalive 16;
}
server {
  listen ${NPM_CACHE.port};
  access_log /dev/stdout npm_cache;
  client_max_body_size 0;
  proxy_max_temp_file_size 0;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_set_header Accept-Encoding gzip;
  proxy_set_header Authorization "";
  proxy_set_header Cookie "";
  gunzip on;
  proxy_cache npm;
  proxy_cache_key "$request_uri $http_accept";
  proxy_ignore_headers Cache-Control Expires Set-Cookie Vary;
  proxy_cache_valid 200 5m;
  proxy_cache_lock on;
  proxy_cache_lock_timeout 60s;
  proxy_cache_lock_age 60s;
  proxy_cache_use_stale updating error timeout http_502 http_503 http_504;
  proxy_cache_background_update on;
  set $npmjs registry.npmjs.org;
  proxy_ssl_server_name on;
  proxy_ssl_verify on;
  proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
  location = /-/npm/v1/keys {
    limit_except GET { deny all; }
    proxy_pass https://$npmjs;
  }
  location ^~ /-/npm/v1/attestations/ {
    limit_except GET { deny all; }
    proxy_pass https://$npmjs;
  }
  location ^~ /-/ {
    proxy_cache off;
    proxy_pass http://verdaccio;
  }
  location ~ \\.tgz$ {
    proxy_cache off;
    proxy_pass http://verdaccio;
  }
  location / {
    proxy_pass http://verdaccio;
  }
}
`
}

/** Verdaccio's config. `max_users: -1` disables registration, so nobody
 *  can authenticate. No web UI. */
function buildNpmCacheConfigYaml(): string {
  const pkg = [
    '    access: $all',
    '    publish: $nobody',
    '    unpublish: $nobody',
    '    proxy: npmjs',
  ]
  return [
    'storage: /verdaccio/storage/data',
    'auth:',
    '  htpasswd:',
    '    file: /verdaccio/storage/htpasswd',
    '    max_users: -1',
    'uplinks:',
    '  npmjs:',
    '    url: https://registry.npmjs.org/',
    'packages:',
    "  '@*/*':",
    ...pkg,
    "  '**':",
    ...pkg,
    'web:',
    '  enable: false',
    'server:',
    '  keepAliveTimeout: 60',
    'middlewares:',
    '  audit:',
    '    enabled: true',
    // Logs each request, showing installs came through here.
    'log:',
    '  type: stdout',
    '  format: pretty',
    '  level: http',
    '',
  ].join('\n')
}

/**
 * Create or update the cache and wait for it to serve (run by `yaac cluster
 * install`). Refuses before applying anything when an image was never
 * mirrored.
 */
export async function ensureNpmCache(): Promise<void> {
  const verdaccio = await prebuiltRef('Verdaccio', VERDACCIO_MIRROR_TAG)
  const nginx = await prebuiltRef('nginx', NGINX_MIRROR_TAG)
  await ensurePackageCache({
    ...NPM_CACHE,
    config: { 'config.yaml': buildNpmCacheConfigYaml(), 'npm-cache.conf.template': buildNpmCacheNginxConf() },
    fsGroup: VERDACCIO_GID,
    // Verdaccio first, so `kubectl logs` defaults to it.
    containers: [{
      name: 'verdaccio',
      image: verdaccio,
      imagePullPolicy: 'IfNotPresent',
      env: [
        { name: 'VERDACCIO_ADDRESS', value: '127.0.0.1' },
        { name: 'VERDACCIO_PORT', value: String(VERDACCIO_PORT) },
        // Tarball URLs in metadata, fixed so nginx can share it.
        { name: 'VERDACCIO_PUBLIC_URL', value: cacheUrl(NPM_CACHE) },
        { name: 'NODE_OPTIONS', value: `--max-old-space-size=${VERDACCIO_MEMORY_MIB * 3 / 4}` },
      ],
      // A full CPU's scheduling weight (two workspaces' requests), so
      // a parse is not starved by the installs it serves; a starved
      // parse is what times out the probe. It is reserved from every
      // install's schedulable CPU (docs/cluster-setup.md).
      resources: {
        requests: { cpu: '1', memory: String(256 * 1024 ** 2) },
        limits: { memory: String(VERDACCIO_MEMORY_MIB * 1024 ** 2) },
      },
      volumeMounts: [
        { name: 'config', mountPath: '/verdaccio/conf', readOnly: true },
        { name: 'storage', mountPath: '/verdaccio/storage' },
      ],
    },
    // Through nginx to Verdaccio's uncached ping.
    cacheNginxContainer(nginx, NPM_CACHE, '/-/ping', { name: 'http-cache', mountPath: '/var/cache/npm' })],
    // Lost on restart; Verdaccio's claim still has every package.
    volumes: [{ name: 'http-cache', emptyDir: {} }],
  })
}
