// Boots the real app on an in-memory Postgres (PGlite) and a random port.
import { connect, close } from '../src/db.js'
import { createApp } from '../src/app.js'

export async function startServer() {
  process.env.NODE_ENV = 'test'
  process.env.JWT_SECRET ||= 'test-secret'
  await connect({ url: '', liteDir: 'memory://' })
  const server = createApp({ log: false }).listen(0)
  await new Promise(r => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}/api`

  // call('POST /auth/signup', body, token) → { status, body }
  const call = async (route, body, token, headers = {}) => {
    const [method, path] = route.split(' ')
    const r = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json', 'X-Timezone': 'UTC',
        ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }

  let n = 0
  const signup = async (over = {}) => {
    const r = await call('POST /auth/signup', { email: `user${++n}@example.com`, password: 'correct horse', name: 'User ' + n, ...over })
    if (r.status !== 201) throw new Error('signup failed: ' + JSON.stringify(r.body))
    return r.body
  }

  return {
    call, signup,
    stop: async () => { await new Promise(r => server.close(r)); await close() }
  }
}
