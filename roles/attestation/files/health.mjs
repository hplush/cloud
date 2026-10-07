// `fetch` can’t use Unix sockets

import { request } from 'node:http'

let req = request(
  { path: '/health', socketPath: '/tmp/health.sock', timeout: 5000 },
  res => {
    res.resume()
    process.exit(res.statusCode === 200 ? 0 : 1)
  }
)
req.on('timeout', () => req.destroy(new Error('Health check timed out')))
req.on('error', () => process.exit(1))
req.end()
