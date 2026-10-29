/**
 * The install's crates.io cache: one nginx that workspace pods' cargo
 * fetches through (docs/workspace-storage.md, "Package installs"). Every
 * workspace pod starts with an empty cargo download cache and `target`, so
 * builds are usually cold; this fetches each crate from crates.io once per
 * cluster. It is deployed like the npm cache (package-cache.ts).
 *
 * It serves cargo's sparse registry protocol, which is plain HTTP files: the
 * index at `/index/` and the `.crate` files at `/crates/`. Workspaces cannot
 * publish through it, and cargo verifies every `.crate` against the index's
 * checksum and `Cargo.lock`, so sharing it across projects is safe. Only pods
 * labelled `LABEL_CRATES_CACHE` at launch (cratesCache on, crates.io allowed,
 * no proxied crates.io secret) can reach it.
 */
import { prebuiltRef } from './registry'
import { CRATES_CACHE, NGINX_MIRROR_TAG, cacheNginxContainer, cacheUrl, ensurePackageCache } from './package-cache'

/** nginx-unprivileged's group, so its uid can write the claim. */
const NGINX_GID = 101

/**
 * nginx's server block, included inside the image's `http {}`. Both caches
 * live on the claim, so they survive a restart and keep serving while
 * crates.io is down.
 *
 * Index files change with every publish, so they are kept one minute
 * (crates.io's CDN keeps them ten), revalidated with the upstream's ETag,
 * and served stale while a refresh runs. A 404 is kept as long, since cargo
 * asks for names that do not exist. `.crate` files never change once
 * published, so they are kept a year. Concurrent identical misses wait on
 * one upstream fetch.
 *
 * The index's `config.json` is answered here, pointing cargo's downloads
 * back at this cache, and names no `api`, so `--registry yaac-crates-cache`
 * has nowhere to publish. (A plain `cargo publish`, like cargo's other
 * crates.io API commands, refuses under source replacement on its own.)
 * Only GET and HEAD go out, without a client's `Authorization` or `Cookie`,
 * and over a certificate-checked connection. Accept-Encoding is dropped so
 * every client is served the one stored copy. Past `max_size`, or when the
 * node's disk has under `min_free` left, nginx evicts least-recently-used
 * entries. Hosts are resolved per request (see `cacheNginxContainer`); IPv6
 * is off because the egress policy allows IPv4 only.
 */
function buildCratesCacheNginxConf(): string {
  const dl = `${cacheUrl(CRATES_CACHE)}crates/{crate}/{crate}-{version}.crate`
  return `proxy_cache_path /var/cache/crates/index levels=1:2 keys_zone=crates_index:10m max_size=2g min_free=2g inactive=30d use_temp_path=off;
proxy_cache_path /var/cache/crates/files levels=1:2 keys_zone=crates_files:32m max_size=16g min_free=2g inactive=90d use_temp_path=off;
log_format crates_cache '$remote_addr "$request" $status $body_bytes_sent $upstream_cache_status $request_time';
resolver \${NGINX_LOCAL_RESOLVERS} ipv6=off valid=60s;
server {
  listen ${CRATES_CACHE.port};
  access_log /dev/stdout crates_cache;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_set_header Accept-Encoding "";
  proxy_set_header Authorization "";
  proxy_set_header Cookie "";
  proxy_ignore_headers Cache-Control Expires Set-Cookie Vary;
  proxy_cache_lock on;
  proxy_cache_lock_timeout 60s;
  proxy_cache_lock_age 60s;
  proxy_cache_revalidate on;
  proxy_cache_use_stale updating error timeout http_500 http_502 http_503 http_504;
  proxy_cache_background_update on;
  set $crates_index index.crates.io;
  set $crates_static static.crates.io;
  proxy_ssl_server_name on;
  proxy_ssl_verify on;
  proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
  location = /index/config.json {
    default_type application/json;
    return 200 '{"dl":"${dl}"}';
  }
  location ^~ /index/ {
    limit_except GET { deny all; }
    rewrite ^/index(/.*)$ $1 break;
    proxy_cache crates_index;
    proxy_cache_valid 200 404 1m;
    proxy_pass https://$crates_index;
  }
  location ^~ /crates/ {
    limit_except GET { deny all; }
    proxy_cache crates_files;
    proxy_cache_valid 200 1y;
    proxy_pass https://$crates_static;
  }
  location / {
    return 404;
  }
}
`
}

/**
 * Create or update the cache and wait for it to serve (run by `yaac cluster
 * install`). Refuses before applying anything when nginx was never mirrored.
 */
export async function ensureCratesCache(): Promise<void> {
  const nginx = await prebuiltRef('nginx', NGINX_MIRROR_TAG)
  await ensurePackageCache({
    ...CRATES_CACHE,
    config: { 'crates-cache.conf.template': buildCratesCacheNginxConf() },
    fsGroup: NGINX_GID,
    // Answered by nginx alone, so a crates.io outage never unreadies a
    // cache that still serves what it holds.
    containers: [cacheNginxContainer(nginx, CRATES_CACHE, '/index/config.json', {
      name: 'storage', mountPath: '/var/cache/crates',
    })],
  })
}
