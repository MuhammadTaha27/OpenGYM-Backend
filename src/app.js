// The HTTP API. Everything except /api/health, /api/config and /api/auth/{signup,login} needs a
// signed-in user (Authorization: Bearer <token>).
import express from 'express'
import cors from 'cors'
import { rateLimit } from 'express-rate-limit'
import { authRoutes, requireAuth, requireAdmin } from './auth.js'
import { exerciseScope } from './logic/exercises.js'
import { recordRoutes } from './routes/records.js'
import { workoutRoutes } from './routes/workout.js'
import { insightRoutes, mealsConfig } from './routes/insights.js'
import { dataRoutes } from './routes/data.js'
import { pushRoutes } from './routes/push.js'
import { adminRoutes } from './routes/admin.js'
import { one } from './db.js'

// Where the app can call from: the web build's own origin(s) plus the Capacitor shells
// (Android serves the app from https://localhost, iOS from capacitor://localhost).
const ORIGINS = [
  'https://localhost', 'http://localhost', 'capacitor://localhost',
  'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:8080',
  ...(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
]

export function createApp({ log = process.env.NODE_ENV !== 'test' } = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)   // behind Render's proxy: req.ip is the client, rate limits are per client

  if (log) {
    app.use((req, res, next) => {
      const t0 = Date.now()
      res.on('finish', () => console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - t0}ms${req.user ? ' u=' + req.user.id : ''}`))
      next()
    })
  }
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || ORIGINS.includes(origin) || process.env.CORS_ORIGINS === '*'),
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Timezone'],
    maxAge: 86400
  }))
  // 8 MB: a meal photo arrives base64-encoded (the app downsizes it to well under 1 MB first).
  app.use(express.json({ limit: '8mb' }))
  app.use(exerciseScope)

  const limiter = rateLimit({ windowMs: 15 * 60000, limit: +(process.env.AUTH_RATE_LIMIT || 30), standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'too many attempts — wait a few minutes and try again' } })

  app.get('/api/health', async (req, res) => {
    await one('SELECT 1 AS ok')
    res.json({ ok: true })
  })
  // What this server offers, needed before anyone signs in.
  app.get('/api/config', (req, res) => res.json({
    signup: !/^(1|true|yes|on)$/i.test(process.env.SIGNUP_DISABLED || ''),
    ...(mealsConfig().on ? { meals: { ai: true } } : {})
  }))

  app.use('/api/auth', authRoutes({ limiter }))
  app.use('/api/admin', requireAdmin, adminRoutes())
  // workoutRoutes first: its /workouts/active must win over the records' /workouts/:id
  app.use('/api', requireAuth, workoutRoutes(), recordRoutes(), insightRoutes(), dataRoutes(), pushRoutes())

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }))
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500
    if (status === 500) console.error(req.method, req.path, err)
    res.status(status).json({ error: status >= 500 ? 'server error' : err.message || 'bad request' })
  })
  return app
}
