/**
 * MITM proxy sidecar for agent session containers.
 *
 * - Generates a self-signed CA on startup (persisted to /data/)
 * - Accepts secret injection rules via HTTP API
 * - Handles CONNECT tunneling: MITMs TLS when rules match, tunnels otherwise
 * - Injects headers into intercepted requests based on host/path patterns
 *
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import forge from 'node-forge'

const PORT = process.env.PORT
const PROXY_AUTH_SECRET = process.env.PROXY_AUTH_SECRET
if (!PORT || !PROXY_AUTH_SECRET) {
  console.error('[proxy] PORT and PROXY_AUTH_SECRET environment variables are required')
  process.exit(1)
}
const DATA_DIR = '/data'

// ── CA Certificate Management ──────────────────────────────────────────

/** @type {{ key: forge.pki.PrivateKey, cert: forge.pki.Certificate, pem: string } | null} */
let ca = null

/** @type {Map<string, { key: string, cert: string, expires: number }>} */
const leafCache = new Map()

const LEAF_VALIDITY_MS = 24 * 60 * 60 * 1000
const LEAF_REFRESH_MS = 60 * 60 * 1000

function loadOrGenerateCA() {
  const keyPath = path.join(DATA_DIR, 'ca.key')
  const certPath = path.join(DATA_DIR, 'ca.pem')

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const keyPem = fs.readFileSync(keyPath, 'utf8')
    const certPem = fs.readFileSync(certPath, 'utf8')
    const key = forge.pki.privateKeyFromPem(keyPem)
    const cert = forge.pki.certificateFromPem(certPem)
    console.log('[proxy] Loaded existing CA from disk')
    return { key, cert, pem: certPem }
  }

  console.log('[proxy] Generating new CA...')
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 10)

  const attrs = [{ name: 'commonName', value: 'yaac Proxy CA' }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())

  const keyPem = forge.pki.privateKeyToPem(keys.privateKey)
  const certPem = forge.pki.certificateToPem(cert)

  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(keyPath, keyPem, { mode: 0o600 })
  fs.writeFileSync(certPath, certPem)
  console.log('[proxy] CA generated and saved to disk')

  return { key: keys.privateKey, cert, pem: certPem }
}

function getLeafCert(hostname) {
  const cached = leafCache.get(hostname)
  const now = Date.now()
  if (cached && (cached.expires - LEAF_REFRESH_MS) > now) {
    return { key: cached.key, cert: cached.cert }
  }

  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  const serialBytes = crypto.randomBytes(16)
  serialBytes[0] &= 0x7f // clear high bit to ensure positive integer
  cert.serialNumber = serialBytes.toString('hex')
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date(now + LEAF_VALIDITY_MS)

  cert.setSubject([{ name: 'commonName', value: hostname }])
  cert.setIssuer(ca.cert.subject.attributes)
  cert.setExtensions([
    { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
  ])
  cert.sign(ca.key, forge.md.sha256.create())

  const keyPem = forge.pki.privateKeyToPem(keys.privateKey)
  const certPem = forge.pki.certificateToPem(cert)

  leafCache.set(hostname, { key: keyPem, cert: certPem, expires: now + LEAF_VALIDITY_MS })
  return { key: keyPem, cert: certPem }
}

// ── Secret Store ───────────────────────────────────────────────────────

/** projectId -> injection rules */
/** @type {Map<string, Array<{ hostPattern: string, pathPattern: string, injections: Array<{ action: string, name: string, value?: string }> }>>} */
const projectRules = new Map()

/** session token -> projectId */
/** @type {Map<string, string>} */
const tokenToProject = new Map()

/** projectId -> allowed host patterns (null means allow all for backward compat) */
/** @type {Map<string, string[]>} */
const projectAllowedHosts = new Map()

// ── Injection Logic ────────────────────────────────────────────────────

function pathMatches(requestPath, pattern) {
  if (pattern === '/*' || pattern === '*') return true
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2)
    return requestPath === prefix || requestPath.startsWith(prefix + '/')
  }
  return requestPath === pattern
}

function hostMatches(hostname, pattern) {
  if (pattern === hostname) return true
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1) // e.g. ".example.com"
    return hostname.endsWith(suffix) && hostname.length > suffix.length
  }
  return false
}

function findRulesForHost(token, hostname) {
  const projectId = tokenToProject.get(token)
  if (!projectId) return []
  const rules = projectRules.get(projectId)
  if (!rules) return []
  return rules.filter((r) => hostMatches(hostname, r.hostPattern))
}

function isHostAllowed(token, hostname) {
  const projectId = token ? tokenToProject.get(token) : undefined
  if (!projectId) return true // no session = no filtering
  const allowed = projectAllowedHosts.get(projectId)
  if (!allowed) return true // no allowlist registered = allow all (backward compat)
  if (allowed.length === 1 && allowed[0] === '*') return true
  return allowed.some((pattern) => hostMatches(hostname, pattern))
}

function applyInjections(headers, requestPath, rules) {
  let count = 0
  for (const rule of rules) {
    if (!pathMatches(requestPath, rule.pathPattern)) continue
    for (const inj of rule.injections) {
      if (inj.action === 'replace_body_param') continue // handled separately
      const headerLower = inj.name.toLowerCase()
      if (inj.action === 'set_header') {
        headers[headerLower] = inj.value
        count++
      } else if (inj.action === 'replace_header') {
        if (headers[headerLower] !== undefined) {
          headers[headerLower] = inj.value
          count++
        }
      } else if (inj.action === 'remove_header') {
        delete headers[headerLower]
        count++
      }
    }
  }
  return count
}

function collectBodyInjections(requestPath, rules) {
  /** @type {Array<{ name: string, value: string }>} */
  const params = []
  for (const rule of rules) {
    if (!pathMatches(requestPath, rule.pathPattern)) continue
    for (const inj of rule.injections) {
      if (inj.action === 'replace_body_param') {
        params.push({ name: inj.name, value: inj.value })
      }
    }
  }
  return params
}

function applyBodyInjections(bodyBuffer, contentType, injections) {
  const bodyStr = bodyBuffer.toString('utf8')
  const isJson = contentType && contentType.includes('application/json')

  if (isJson) {
    try {
      const obj = JSON.parse(bodyStr)
      for (const { name, value } of injections) {
        if (name in obj) {
          obj[name] = value
        }
      }
      return Buffer.from(JSON.stringify(obj), 'utf8')
    } catch {
      // Not valid JSON — fall through to form-encoded
    }
  }

  // Default: application/x-www-form-urlencoded
  const params = new URLSearchParams(bodyStr)
  for (const { name, value } of injections) {
    if (params.has(name)) {
      params.set(name, value)
    }
  }
  return Buffer.from(params.toString(), 'utf8')
}

// ── Token Extraction ───────────────────────────────────────────────────

function extractToken(proxyAuthHeader) {
  if (!proxyAuthHeader) return null
  const match = proxyAuthHeader.match(/^Basic\s+(.+)$/i)
  if (!match) return null
  const decoded = Buffer.from(match[1], 'base64').toString()
  const colonIdx = decoded.indexOf(':')
  if (colonIdx === -1) return decoded
  const password = decoded.slice(colonIdx + 1)
  return password || decoded.slice(0, colonIdx)
}

// ── MITM Handler ───────────────────────────────────────────────────────

function handleMitm(clientSocket, hostname, port, rules) {
  const leaf = getLeafCert(hostname)

  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer: true,
    key: leaf.key,
    cert: leaf.cert + ca.pem,
  })

  const mitmServer = http.createServer((req, res) => {
    const reqPath = req.url || '/'

    const headers = { ...req.headers }
    delete headers['proxy-authorization']
    delete headers['proxy-connection']

    const injCount = applyInjections(headers, reqPath, rules)
    const bodyInjections = collectBodyInjections(reqPath, rules)

    const totalInj = injCount + bodyInjections.length
    if (totalInj > 0) {
      console.log(`[proxy] MITM ${req.method} https://${hostname}${reqPath} (${injCount} header + ${bodyInjections.length} body injections)`)
    }

    function sendUpstream(body) {
      if (body !== null) {
        headers['content-length'] = String(body.length)
      }
      const upstream = https.request({
        hostname,
        port: parseInt(port, 10) || 443,
        path: reqPath,
        method: req.method,
        headers,
        rejectUnauthorized: true,
      }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers)
        upstreamRes.pipe(res)
      })

      upstream.on('error', (err) => {
        console.error(`[proxy] Upstream error for ${hostname}${reqPath}:`, err.message)
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' })
        }
        res.end(err.message)
      })

      if (body !== null) {
        upstream.end(body)
      } else {
        req.pipe(upstream)
      }
    }

    if (bodyInjections.length > 0) {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks)
        const modified = applyBodyInjections(rawBody, headers['content-type'], bodyInjections)
        sendUpstream(modified)
      })
    } else {
      sendUpstream(null)
    }
  })

  mitmServer.emit('connection', tlsSocket)

  tlsSocket.on('error', (err) => {
    if (err.code !== 'ECONNRESET') {
      console.error(`[proxy] TLS error for ${hostname}:`, err.message)
    }
  })
}

// ── Tunnel Handler ─────────────────────────────────────────────────────

function handleTunnel(clientSocket, hostname, port) {
  const upstream = net.connect(parseInt(port, 10) || 443, hostname, () => {
    clientSocket.pipe(upstream)
    upstream.pipe(clientSocket)
  })

  upstream.on('error', (err) => {
    console.error(`[proxy] Tunnel error for ${hostname}:`, err.message)
    clientSocket.end()
  })

  clientSocket.on('error', () => {
    upstream.destroy()
  })
}

// ── API Request Handler ────────────────────────────────────────────────

function checkAuth(req) {
  const auth = req.headers.authorization
  return auth === `Bearer ${PROXY_AUTH_SECRET}`
}

function handleApiRequest(req, res) {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200)
    res.end('ok')
    return
  }

  if (req.method === 'GET' && req.url === '/ca.pem') {
    if (!ca) {
      res.writeHead(503)
      res.end('CA not ready')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/x-pem-file' })
    res.end(ca.pem)
    return
  }

  // Register or update injection rules for a project
  if (req.method === 'PUT' && req.url?.match(/^\/projects\/[^/]+\/rules$/)) {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    const projectId = decodeURIComponent(req.url.split('/')[2])
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        const { rules, allowedHosts } = JSON.parse(body)
        if (!Array.isArray(rules)) { res.writeHead(400); res.end('Invalid body: need rules array'); return }
        projectRules.set(projectId, rules)
        if (Array.isArray(allowedHosts)) {
          projectAllowedHosts.set(projectId, allowedHosts)
          console.log(`[proxy] Updated allowlist (${allowedHosts.length} patterns) for project ${projectId.slice(0, 8)}...`)
        } else {
          projectAllowedHosts.delete(projectId)
        }
        console.log(`[proxy] Updated ${rules.length} rules for project ${projectId.slice(0, 8)}...`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(400); res.end(`Invalid JSON: ${err.message}`)
      }
    })
    return
  }

  // Remove all rules for a project
  if (req.method === 'DELETE' && req.url?.match(/^\/projects\/[^/]+\/rules$/)) {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    const projectId = decodeURIComponent(req.url.split('/')[2])
    const deleted = projectRules.delete(projectId)
    projectAllowedHosts.delete(projectId)
    console.log(`[proxy] Removed rules for project ${projectId.slice(0, 8)}... (found: ${deleted})`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, deleted }))
    return
  }

  // Register a session token → project mapping
  if (req.method === 'POST' && req.url === '/sessions') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        const { token, projectId } = JSON.parse(body)
        if (!token || !projectId) { res.writeHead(400); res.end('Invalid body: need token and projectId'); return }
        tokenToProject.set(token, projectId)
        console.log(`[proxy] Registered session ${token.slice(0, 8)}... → project ${projectId.slice(0, 8)}...`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(400); res.end(`Invalid JSON: ${err.message}`)
      }
    })
    return
  }

  // Remove a session token mapping
  if (req.method === 'DELETE' && req.url?.startsWith('/sessions/')) {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    const token = decodeURIComponent(req.url.slice('/sessions/'.length))
    const deleted = tokenToProject.delete(token)
    console.log(`[proxy] Removed session ${token.slice(0, 8)}... (found: ${deleted})`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, deleted }))
    return
  }

  res.writeHead(404)
  res.end('Not found')
}

// ── Server ─────────────────────────────────────────────────────────────

ca = loadOrGenerateCA()

// ── HTTP Forward Proxy ────────────────────────────────────────────────

function isProxyRequest(req) {
  return req.url && req.url.startsWith('http://')
}

// Security: token injection is deliberately NOT applied to plain HTTP requests.
// Injecting credentials over unencrypted connections would expose them to
// network observers. Only HTTPS CONNECT+MITM requests get token injection.
function handleHttpForward(req, res) {
  const target = new URL(req.url)
  const token = extractToken(req.headers['proxy-authorization'])

  if (!isHostAllowed(token, target.hostname)) {
    console.log(`[proxy] BLOCKED HTTP forward to ${target.hostname} (not in allowlist)`)
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end(`Blocked by URL allowlist: ${target.hostname} is not in the allowed hosts`)
    return
  }

  const headers = { ...req.headers }
  delete headers['proxy-authorization']
  delete headers['proxy-connection']
  headers.host = target.host

  const upstream = http.request({
    hostname: target.hostname,
    port: parseInt(target.port, 10) || 80,
    path: target.pathname + target.search,
    method: req.method,
    headers,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers)
    upstreamRes.pipe(res)
  })

  upstream.on('error', (err) => {
    console.error(`[proxy] HTTP forward error for ${req.url}:`, err.message)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
    }
    res.end(err.message)
  })

  req.pipe(upstream)
}

// ── Server ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (isProxyRequest(req)) {
    handleHttpForward(req, res)
  } else {
    handleApiRequest(req, res)
  }
})

server.on('connect', (req, clientSocket, head) => {
  const [hostname, port] = req.url.split(':')
  const token = extractToken(req.headers['proxy-authorization'])

  clientSocket.on('error', (err) => {
    if (err.code !== 'ECONNRESET') {
      console.error(`[proxy] Client socket error for ${hostname}:${port}:`, err.message)
    }
  })

  if (!isHostAllowed(token, hostname)) {
    console.log(`[proxy] BLOCKED CONNECT to ${hostname}:${port} (not in allowlist)`)
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    clientSocket.end()
    return
  }

  const rules = token ? findRulesForHost(token, hostname) : []

  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

  if (head.length > 0) {
    clientSocket.unshift(head)
  }

  if (rules.length > 0) {
    handleMitm(clientSocket, hostname, port, rules)
  } else {
    handleTunnel(clientSocket, hostname, port)
  }
})

server.on('error', (err) => {
  console.error('[proxy] Server error:', err)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[proxy] MITM proxy listening on port ${PORT}`)
})

process.on('SIGTERM', () => {
  console.log('[proxy] Shutting down...')
  server.close(() => process.exit(0))
})
