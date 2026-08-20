// Internal web API to deploy new versions of website images.
//
// GitHub Actions calls it after publishing an image. To prove that the call
// came from GitHub and from the repository of this exact website, the workflow
// asks GitHub for an OIDC token (`permissions: id-token: write`) and sends it
// in the `Authorization` header. We check the token signature against GitHub
// keys and compare the `repository` claim with our config.
//
// A valid call creates a request file. The website user watches the directory
// with a systemd path unit and starts the deploy on its own, so this server
// never runs any command and does not need any extra permissions.
//
// The deploy script answers with a file named after the request, and we hold
// the HTTP connection until it appears. Without it a workflow would report
// a success for an image which never started.

import { readFile, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { setTimeout } from 'node:timers/promises'

const ISSUER = 'https://token.actions.githubusercontent.com'
const JWKS_URL = `${ISSUER}/.well-known/jwks`
// GitHub rotates the signing keys, so we can’t cache them forever
const JWKS_TTL = 60 * 60 * 1000
const JWKS_RETRY = 60 * 1000
const CLOCK_SKEW = 60

// `deploy.service` gives up after 10 minutes. We wait a bit longer to answer
// with the log of the failed deploy instead of our own timeout.
const DEPLOY_TIMEOUT = 11 * 60 * 1000
const DEPLOY_POLL = 500

const PORT = Number(process.env.PORT || 8000)
const AUDIENCE = process.env.AUDIENCE
const CONFIG = process.env.CONFIG || '/app/services.json'

const services = JSON.parse(await readFile(CONFIG, 'utf8'))

class HttpError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

let jwks = { keys: [], loadedAt: 0 }

async function loadKeys() {
  let response = await fetch(JWKS_URL)
  if (!response.ok) {
    throw new HttpError(502, `GitHub keys request returned ${response.status}`)
  }
  let body = await response.json()
  jwks = { keys: body.keys || [], loadedAt: Date.now() }
}

async function findKey(kid) {
  if (Date.now() - jwks.loadedAt > JWKS_TTL) await loadKeys()
  let key = jwks.keys.find(i => i.kid === kid)
  if (!key && Date.now() - jwks.loadedAt > JWKS_RETRY) {
    await loadKeys()
    key = jwks.keys.find(i => i.kid === kid)
  }
  if (!key) throw new HttpError(401, 'Unknown token key')
  return key
}

function decodePart(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    throw new HttpError(401, 'Malformed token')
  }
}

async function verifyToken(token) {
  let parts = token.split('.')
  if (parts.length !== 3) throw new HttpError(401, 'Malformed token')

  let header = decodePart(parts[0])
  if (header.alg !== 'RS256') throw new HttpError(401, 'Unexpected token type')

  let jwk = await findKey(header.kid)
  let algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
  let key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e },
    algorithm,
    false,
    ['verify']
  )
  let valid = await crypto.subtle.verify(
    algorithm.name,
    key,
    Buffer.from(parts[2], 'base64url'),
    Buffer.from(`${parts[0]}.${parts[1]}`)
  )
  if (!valid) throw new HttpError(401, 'Wrong token signature')

  let payload = decodePart(parts[1])
  let now = Math.floor(Date.now() / 1000)
  if (payload.iss !== ISSUER) throw new HttpError(401, 'Wrong token issuer')
  if (payload.aud !== AUDIENCE) throw new HttpError(401, 'Wrong token audience')
  if (!payload.exp || payload.exp + CLOCK_SKEW < now) {
    throw new HttpError(401, 'Expired token')
  }
  if (payload.nbf && payload.nbf - CLOCK_SKEW > now) {
    throw new HttpError(401, 'Token is not valid yet')
  }
  return payload
}

async function waitForDeploy(file, req) {
  let deadline = Date.now() + DEPLOY_TIMEOUT
  while (Date.now() < deadline) {
    // GitHub Actions could be canceled while we are waiting
    if (req.destroyed) throw new HttpError(499, 'The client is gone')
    let result
    try {
      result = await readFile(file, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await setTimeout(DEPLOY_POLL)
      continue
    }
    await unlink(file).catch(() => {})
    let split = result.indexOf('\n')
    if (split === -1) return { log: '', status: result }
    return { log: result.slice(split + 1), status: result.slice(0, split) }
  }
  throw new HttpError(504, 'The deploy did not finish in time')
}

async function route(req) {
  let url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    return 'OK'
  }

  let deploy = url.pathname.match(/^\/deploy\/([^/]+)$/)
  if (!deploy) throw new HttpError(404, 'Unknown endpoint')
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST')

  let domain = decodeURIComponent(deploy[1])
  let service = services[domain]
  if (!service) throw new HttpError(404, `Unknown website ${domain}`)

  let auth = req.headers.authorization || ''
  if (!auth.startsWith('Bearer ')) {
    throw new HttpError(401, 'No GitHub Actions token')
  }
  let token = await verifyToken(auth.slice('Bearer '.length))
  if (token.repository !== service.repository) {
    throw new HttpError(403, `${token.repository} can’t deploy ${domain}`)
  }
  if (token.workflow_ref !== service.workflow_ref) {
    throw new HttpError(403, `${token.workflow_ref} can’t deploy ${domain}`)
  }
  if (token.ref !== service.ref) {
    throw new HttpError(403, `${token.ref} can’t deploy ${domain}`)
  }

  let id = crypto.randomUUID()
  await writeFile(
    `${service.requests}/${id}`,
    `${token.repository} ${token.sha || ''}\n`
  )
  console.log(`Deploy of ${domain} requested by ${token.workflow_ref}`)

  let { log, status } = await waitForDeploy(`${service.results}/${id}`, req)
  if (status !== 'ok') {
    throw new HttpError(500, `Deploy of ${domain} failed\n${log}`)
  }
  return `Deploy of ${domain} finished\n${log}`
}

const server = createServer((req, res) => {
  // We never read the request body, but the socket should not stay full
  req.resume()
  route(req)
    .then(message => {
      // A deploy takes minutes, and the client can leave before the answer
      if (req.destroyed) return
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`${message}\n`)
    })
    .catch(error => {
      let code = error instanceof HttpError ? error.code : 500
      if (!(error instanceof HttpError)) console.error(error)
      else if (code >= 500) console.error(error.message)
      else console.warn(`${code}: ${error.message}`)
      if (req.destroyed) return
      res.writeHead(code, { 'content-type': 'text/plain' })
      res.end(`${error.message}\n`)
    })
})

for (let signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}

server.listen(PORT, () => {
  console.log(`deploy API is listening on ${PORT}`)
})
