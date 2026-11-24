/**
 * The main registry's gate (docs/image-builds.md, "The gate"): an
 * Envoy container in the registry's own pod, in front of a `registry:2`
 * that listens only on the pod's loopback. It listens on two ports, which
 * the registry's ingress policy hands to different callers:
 *
 *  - the node port, for node addresses only (containerd, the kubelet, a
 *    host `port-forward`): reads are anonymous, so pulls need no
 *    credentials;
 *  - the pod port, for builder pods and the server: a read of a project,
 *    user or build-cache repo needs a grant naming it, and the catalog is
 *    refused, so one project's build cannot read another's images.
 *
 * On both, a write (any method but GET and HEAD) must carry a grant
 * (registry-grant.ts) whose signature verifies against the public key
 * rendered into this config, whose expiry has not passed, and whose scope
 * names the repository the path writes. A cross-repo mount also needs the
 * source repo in scope when that repo is protected. DELETE is refused
 * outright: the main registry never deletes over the API (its GC works on
 * storage).
 *
 * Every 401 carries a Basic challenge, and so does `/v2/` when a request has
 * no credentials. The challenge is what makes podman and BuildKit send the
 * credentials they hold at all: both attach Basic auth only for a registry
 * that asked for it. Kubelet and containerd never request `/v2/` itself.
 */

/** Where registry:2 listens, reachable only from inside its pod. */
export const REGISTRY_BACKEND_PORT = 5001

/** Mount point of the gate's ConfigMap in the Envoy container. */
export const REGISTRY_GATE_CONFIG_DIR = '/etc/yaac-registry-gate'

/**
 * The gate's logic, as an Envoy Lua filter. `gateReads` is true on the pod
 * port. LuaJIT has no base64 decoder,
 * so a small one is inlined. Paths reach it already normalized — dot
 * segments resolved, slashes merged, escaped slashes rejected — by the
 * connection manager's settings below, so the repo it reads is the repo the
 * registry writes.
 */
function gateLua(publicKeyDer: Buffer, gateReads: boolean): string {
  return `
local B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
local function b64decode(s)
  s = s:gsub('%-', '+'):gsub('_', '/'):gsub('[^%w%+/]', '')
  local bits = s:gsub('.', function(c)
    local n = B64:find(c, 1, true) - 1
    local out = ''
    for i = 5, 0, -1 do out = out .. math.floor(n / 2 ^ i) % 2 end
    return out
  end)
  bits = bits:sub(1, #bits - #bits % 8)
  return (bits:gsub('%d%d%d%d%d%d%d%d', function(byte)
    return string.char(tonumber(byte, 2))
  end))
end

local KEY_DER = b64decode('${publicKeyDer.toString('base64')}')
local GATE_READS = ${gateReads ? 'true' : 'false'}

local function refuse(handle, status, message)
  handle:respond({
    [':status'] = status,
    ['www-authenticate'] = 'Basic realm="yaac-registry"',
    ['content-type'] = 'text/plain',
  }, message .. '\\n')
end

local function grantScope(handle, authorization)
  local encoded = authorization and authorization:match('^[Bb]asic%s+(%S+)$')
  local password = encoded and b64decode(encoded):match('^[^:]*:(.*)$')
  local payload, signature = (password or ''):match('^(.+)%.([%w_-]+)$')
  if not payload then return nil end
  local expiry, scope = payload:match('^v1|(%d+)|(.+)$')
  if not expiry or tonumber(expiry) < os.time() then return nil end
  local sig = b64decode(signature)
  local key = handle:importPublicKey(KEY_DER, #KEY_DER):get()
  if not handle:verifySignature('sha256', key, sig, #sig, payload, #payload) then return nil end
  return scope
end

-- A project, user or build-cache repo: <prefix>-proj-<uuid> and the like.
local function protected(repo)
  local name = repo:match('[^/]+$') or ''
  for _, kind in ipairs({ 'proj', 'user', 'buildcache' }) do
    if name:match('%-' .. kind .. '%-%x%x%x%x%x%x%x%x%-') then return true end
  end
  return false
end

local function covers(scope, repo)
  if scope == '*' then return true end
  for granted in scope:gmatch('[^,]+') do
    if granted == repo then return true end
  end
  return false
end

local function unescape(s)
  return (s:gsub('%%(%x%x)', function(h) return string.char(tonumber(h, 16)) end))
end

local function gate(handle)
  local headers = handle:headers()
  local method = headers:get(':method')
  local fullpath = headers:get(':path') or ''
  local path = fullpath:match('^[^?]*')
  local authorization = headers:get('authorization')
  if path == '/v2/' or path == '/v2' then
    if not authorization then refuse(handle, '401', 'credentials required') end
    return
  end
  if method == 'GET' or method == 'HEAD' then
    if not GATE_READS then return end
    local repo = path:match('^/v2/(.+)/manifests/[^/]+$')
      or path:match('^/v2/(.+)/blobs/[^/]+$')
      or path:match('^/v2/(.+)/tags/list$')
    if not repo then return refuse(handle, '403', 'this port serves only manifest, blob and tag reads') end
    if not protected(repo) then return end
    local scope = grantScope(handle, authorization)
    if not scope then return refuse(handle, '401', 'a valid registry grant is required to read ' .. repo) end
    if covers(scope, repo) then return end
    return refuse(handle, '403', 'this grant does not cover ' .. repo)
  end
  if method == 'DELETE' then return refuse(handle, '403', 'deletes are disabled') end
  local scope = grantScope(handle, authorization)
  if not scope then return refuse(handle, '401', 'a valid registry grant is required to write') end
  -- Anchored on each write route's TAIL, as distribution routes them: the
  -- name is everything before it, and 'blobs' is a legal name component.
  -- Any other shape names no repo, so it is refused.
  local repo = path:match('^/v2/(.+)/manifests/[^/]+$')
    or path:match('^/v2/(.+)/blobs/uploads/[^/]*$')
  if not repo or not covers(scope, repo) then
    return refuse(handle, '403', 'this grant does not cover ' .. (repo or path))
  end
  -- A mount copies a blob out of its source repo, which is a read of it.
  local from = fullpath:match('[?&]from=([^&]*)')
  if from and protected(unescape(from)) and not covers(scope, unescape(from)) then
    return refuse(handle, '403', 'this grant does not cover ' .. unescape(from))
  end
end

function envoy_on_request(handle)
  local ok, err = pcall(gate, handle)
  if not ok then
    handle:logErr('registry gate: ' .. tostring(err))
    refuse(handle, '500', 'registry gate error')
  end
end
`
}

/**
 * Envoy's static bootstrap: the node and pod listeners, each with its Lua
 * gate, and the loopback registry behind them.
 *
 * The route timeout is off: a blob upload is one long PATCH, and Envoy's
 * default 15s would cut every push of a real layer. Idle streams are still
 * bounded by the connection manager's default stream idle timeout.
 */
export function registryGateBootstrap(
  ports: { node: number; pod: number },
  publicKeyDer: Buffer,
): string {
  const listener = (name: string, port: number, gateReads: boolean): Record<string, unknown> => ({
    name,
    address: { socket_address: { address: '0.0.0.0', port_value: port } },
    filter_chains: [{
      filters: [{
        name: 'envoy.filters.network.http_connection_manager',
        typed_config: {
          '@type': 'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
          stat_prefix: name,
          normalize_path: true,
          merge_slashes: true,
          path_with_escaped_slashes_action: 'REJECT_REQUEST',
          route_config: {
            virtual_hosts: [{
              name: 'registry',
              domains: ['*'],
              routes: [{ match: { prefix: '/' }, route: { cluster: 'registry', timeout: '0s' } }],
            }],
          },
          http_filters: [
            {
              name: 'envoy.filters.http.lua',
              typed_config: {
                '@type': 'type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua',
                default_source_code: { inline_string: gateLua(publicKeyDer, gateReads) },
              },
            },
            {
              name: 'envoy.filters.http.router',
              typed_config: {
                '@type': 'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router',
              },
            },
          ],
        },
      }],
    }],
  })
  return JSON.stringify({
    static_resources: {
      listeners: [listener('node', ports.node, false), listener('pod', ports.pod, true)],
      clusters: [{
        name: 'registry',
        type: 'STATIC',
        connect_timeout: '5s',
        load_assignment: {
          cluster_name: 'registry',
          endpoints: [{
            lb_endpoints: [{
              endpoint: {
                address: {
                  socket_address: { address: '127.0.0.1', port_value: REGISTRY_BACKEND_PORT },
                },
              },
            }],
          }],
        },
      }],
    },
  }, null, 2)
}
