// Test version of Google Confidential Space attestation. Our own issuer,
// key, and honest hardware claims, so tokens never pass as Google’s.
// Each container has its own socket, so we never ask the request who it is.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign
} from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile, unlink } from 'node:fs/promises'
import { createServer } from 'node:http'

const VERSION = '1'
const TOKEN_TTL = 60 * 60
const HEALTH = '/tmp/health.sock'

// Limits of Google’s launcher
const MAX_AUDIENCE = 512
const MAX_NONCES = 6
const MIN_NONCE = 10
const MAX_NONCE = 74
const FIELDS = ['audience', 'token_type', 'nonces']

const MAX_BODY = 16 * 1024
const MAX_REGISTRATION = 4 * 1024
const DIGEST = /^sha256:[0-9a-f]{64}$/

const CONFIG = process.env.CONFIG || '/app/containers.json'
const KEY = process.env.KEY || '/key/private.pem'
const DIR = process.env.DIR || '/var/lib/attestation'

const config = JSON.parse(await readFile(CONFIG, 'utf8'))

const privateKey = createPrivateKey(await readFile(KEY))
if (
  privateKey.asymmetricKeyType !== 'rsa' ||
  privateKey.asymmetricKeyDetails.modulusLength < 2048
) {
  throw new Error('The signing key must be RSA with at least 2048 bits')
}
const jwk = createPublicKey(privateKey).export({ format: 'jwk' })
// RFC 7638 thumbprint: exactly these members in this order, no spaces
const kid = createHash('sha256')
  .update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }))
  .digest('base64url')
const jwks = JSON.stringify({
  keys: [{ kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig', kid }]
})

class HttpError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function readBody(req) {
  if (Number(req.headers['content-length']) > MAX_BODY) {
    return Promise.reject(new HttpError(400, 'Request body is too large'))
  }
  return new Promise((resolve, reject) => {
    let chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new HttpError(400, 'Request body is too large'))
      } else {
        chunks.push(chunk)
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseRequest(body) {
  let request
  try {
    request = JSON.parse(body)
  } catch {
    throw new HttpError(400, 'Request body is not JSON')
  }
  if (
    typeof request !== 'object' ||
    request === null ||
    Array.isArray(request)
  ) {
    throw new HttpError(400, 'Request body is not a JSON object')
  }
  for (let key of Object.keys(request)) {
    if (!FIELDS.includes(key)) {
      throw new HttpError(400, `Unknown field ${JSON.stringify(key)}`)
    }
  }

  let { audience, nonces = [], token_type: type } = request
  if (typeof audience !== 'string' || audience === '') {
    throw new HttpError(400, 'audience is required')
  }
  if (Buffer.byteLength(audience) > MAX_AUDIENCE) {
    throw new HttpError(400, `audience is longer than ${MAX_AUDIENCE} bytes`)
  }

  if (type === 'PKI' || type === 'AWS_PRINCIPALTAGS') {
    throw new HttpError(400, `${type} tokens are not supported on hplush cloud`)
  }
  if (type === undefined || type === '') {
    throw new HttpError(400, 'token_type is required')
  }
  if (type !== 'OIDC') {
    throw new HttpError(400, `Unknown token_type ${JSON.stringify(type)}`)
  }

  // Go decodes `null` into an empty list
  if (nonces === null) nonces = []
  if (!Array.isArray(nonces)) {
    throw new HttpError(400, 'nonces is not an array')
  }
  if (nonces.length > MAX_NONCES) {
    throw new HttpError(400, `More than ${MAX_NONCES} nonces`)
  }
  for (let nonce of nonces) {
    if (
      typeof nonce !== 'string' ||
      Buffer.byteLength(nonce) < MIN_NONCE ||
      Buffer.byteLength(nonce) > MAX_NONCE
    ) {
      throw new HttpError(
        400,
        `Every nonce must be a string of ${MIN_NONCE}–${MAX_NONCE} bytes`
      )
    }
  }

  return { audience, nonces }
}

function isDigest(value) {
  return typeof value === 'string' && DIGEST.test(value)
}

// The website user can put a symlink or a FIFO here instead of a file
async function readRegistration(container) {
  let file = `${DIR}/registry/${container.user}/${container.name}.json`
  let handle
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new HttpError(503, `${container.name} is not registered yet`)
    }
    throw error
  }

  let text
  try {
    let stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_REGISTRATION) {
      throw new HttpError(500, `Registration of ${container.name} is broken`)
    }
    let buffer = Buffer.alloc(MAX_REGISTRATION)
    let { bytesRead } = await handle.read(buffer, 0, MAX_REGISTRATION, 0)
    text = buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }

  let registration
  try {
    registration = JSON.parse(text)
  } catch {
    throw new HttpError(500, `Registration of ${container.name} is broken`)
  }
  if (registration?.image_reference !== container.image) {
    throw new HttpError(
      500,
      `${container.name} is registered with another image`
    )
  }
  if (
    !isDigest(registration.image_digest) ||
    !isDigest(registration.image_id)
  ) {
    throw new HttpError(500, `Registration of ${container.name} is broken`)
  }
  return registration
}

function encode(data) {
  return Buffer.from(JSON.stringify(data)).toString('base64url')
}

// Never put `env` or `args` here: they have the database password
function createToken(container, registration, audience, nonces) {
  let now = Math.floor(Date.now() / 1000)
  let payload = {
    iss: config.issuer,
    sub: `${config.issuer}/containers/${container.user}/${container.name}`,
    aud: audience,
    iat: now,
    nbf: now,
    exp: now + TOKEN_TTL,
    jti: randomUUID(),
    // A string for one nonce, an array for many, no claim for none
    eat_nonce: nonces.length > 1 ? nonces : nonces[0],
    // Honest values, which production verifiers reject
    hwmodel: 'HPLUSH_TEST',
    swname: 'HPLUSH_TEST',
    swversion: [VERSION],
    dbgstat: 'enabled',
    secboot: false,
    submods: {
      confidential_space: {
        support_attributes: []
      },
      container: {
        image_reference: registration.image_reference,
        image_digest: registration.image_digest,
        image_id: registration.image_id,
        restart_policy: 'Always'
      }
    },
    google_service_accounts: []
  }
  let header = { alg: 'RS256', kid, typ: 'JWT' }
  let input = `${encode(header)}.${encode(payload)}`
  let signature = sign('sha256', Buffer.from(input), privateKey)
  return `${input}.${signature.toString('base64url')}`
}

async function issueToken(container, req) {
  let url = new URL(req.url, 'http://localhost')
  if (url.pathname !== '/v1/token') throw new HttpError(404, 'Unknown endpoint')
  // 400 like Google
  if (req.method !== 'POST') {
    throw new HttpError(400, 'Use POST, hplush cloud has no default token')
  }

  let { audience, nonces } = parseRequest(await readBody(req))
  let registration = await readRegistration(container)
  let token = createToken(container, registration, audience, nonces)
  console.log(
    `Token for ${container.name} to ${JSON.stringify(audience)} ` +
      `with ${registration.image_digest}`
  )
  return token
}

function answer(container) {
  return (req, res) => {
    issueToken(container, req)
      .then(token => {
        // Sic, like Google’s launcher
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(token)
      })
      .catch(error => {
        let code = error instanceof HttpError ? error.code : 500
        let message =
          error instanceof HttpError ? error.message : 'Internal error'
        if (!(error instanceof HttpError)) console.error(error)
        else if (code >= 500) console.error(error.message)
        else console.warn(`${container.name} ${code}: ${error.message}`)
        // Don’t read the rest of a too large body
        res.writeHead(code, {
          connection: 'close',
          'content-type': 'text/plain; charset=utf-8'
        })
        res.end(`${message}\n`)
      })
  }
}

async function listen(server, path, options = {}) {
  await unlink(path).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ path, ...options }, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function answerKey(req, res) {
  let found = req.url.split('?')[0] === '/.well-known/jwks.json'
  let allowed = req.method === 'GET' || req.method === 'HEAD'
  if (!found || !allowed) {
    res.writeHead(found ? 405 : 404, { 'content-type': 'text/plain' })
    res.end(found ? 'Use GET\n' : 'Not found\n')
    return
  }
  res.writeHead(200, {
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=300',
    'content-type': 'application/json'
  })
  res.end(`${jwks}\n`)
}

const TIMEOUTS = { headersTimeout: 5000, requestTimeout: 10000 }

let servers = []

for (let container of config.containers) {
  let server = createServer(TIMEOUTS, answer(container))
  // Container processes are “others” on the host
  await listen(
    server,
    `${DIR}/sockets/${container.user}/${container.name}/teeserver.sock`,
    { readableAll: true, writableAll: true }
  )
  servers.push(server)
}

let keyServer = createServer(TIMEOUTS, answerKey)
await listen(keyServer, `${DIR}/caddy/jwks.sock`, {
  readableAll: true,
  writableAll: true
})
servers.push(keyServer)

let health = createServer((req, res) => {
  let ok = req.method === 'GET' && req.url === '/health'
  res.writeHead(ok ? 200 : 404, { 'content-type': 'text/plain' })
  res.end(ok ? 'OK\n' : 'Not found\n')
})
await listen(health, HEALTH)
servers.push(health)

for (let signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    Promise.all(
      servers.map(server => new Promise(resolve => server.close(resolve)))
    ).then(() => process.exit(0))
  })
}

console.log(
  `attestation signer is listening for ${config.containers.length} containers`
)
