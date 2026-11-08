// Email + password accounts. Passwords are bcrypt-hashed; a session is a signed JWT the app
// sends as `Authorization: Bearer …`. The token carries the user's token_version, so bumping
// it ("sign out everywhere", a password change) invalidates every token already handed out.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { Router } from 'express'
import { q, one } from './db.js'
import { h, HttpError, bad, str } from './http.js'

const SESSION_DAYS = Math.max(1, +(process.env.SESSION_DAYS || 90) || 90)
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
const SIGNUP_DISABLED = /^(1|true|yes|on)$/i.test(process.env.SIGNUP_DISABLED || '')

// The signing secret: JWT_SECRET (hosted), else one generated once and kept in DATA_DIR
// (Docker self-hosting), else a throwaway one for local development.
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET
  if (process.env.DATA_DIR) {
    const file = path.join(process.env.DATA_DIR, 'jwt-secret')
    if (!fs.existsSync(file)) {
      fs.mkdirSync(process.env.DATA_DIR, { recursive: true })
      fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 })
    }
    return fs.readFileSync(file, 'utf8').trim()
  }
  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET must be set in production')
  console.warn('JWT_SECRET not set — using a random dev secret (sessions end when the server restarts)')
  return 'dev-only-' + crypto.randomBytes(16).toString('hex')
}
const SECRET = loadSecret()

export const isAdmin = u => !!u && (u.is_admin || ADMIN_EMAILS.includes(u.email))
export const publicUser = u => ({ id: u.id, name: u.name, email: u.email, admin: isAdmin(u) })

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/
function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase()
  if (!EMAIL_RE.test(e)) throw bad('enter a valid email address')
  return e
}
function checkPassword(p) {
  const s = String(p || '')
  if (s.length < 8) throw bad('password must be at least 8 characters')
  if (s.length > 200) throw bad('password is too long')
  return s
}

const sign = u => jwt.sign({ sub: u.id, v: u.token_version }, SECRET, { expiresIn: SESSION_DAYS + 'd' })
const session = u => ({ token: sign(u), user: publicUser(u) })

/** Middleware: resolves the bearer token to req.user, or 401. */
export const requireAuth = h(async (req, res, next) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '')
  if (!m) throw new HttpError(401, 'not signed in')
  let claims
  try { claims = jwt.verify(m[1], SECRET) } catch { throw new HttpError(401, 'session expired — sign in again') }
  const u = await one('SELECT * FROM users WHERE id = $1', [claims.sub])
  if (!u || u.disabled || u.token_version !== claims.v) throw new HttpError(401, 'session expired — sign in again')
  req.user = u
  next()
})

export const requireAdmin = [requireAuth, (req, res, next) => (isAdmin(req.user) ? next() : next(new HttpError(403, 'forbidden')))]

export function authRoutes({ limiter }) {
  const r = Router()

  r.post('/signup', limiter, h(async (req, res) => {
    if (SIGNUP_DISABLED) throw new HttpError(403, 'sign-ups are closed on this server')
    const email = cleanEmail(req.body.email)
    const password = checkPassword(req.body.password)
    const name = str(req.body.name, 40)?.trim() || email.split('@')[0]
    if (await one('SELECT 1 FROM users WHERE email = $1', [email])) throw new HttpError(409, 'an account with this email already exists')
    const u = await one(
      `INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4) RETURNING *`,
      [crypto.randomBytes(12).toString('base64url'), email, name, await bcrypt.hash(password, 11)])
    res.status(201).json(session(u))
  }))

  r.post('/login', limiter, h(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase()
    const u = await one('SELECT * FROM users WHERE email = $1', [email])
    // Same answer for "no such account" and "wrong password" — the form shouldn't tell anyone
    // which emails are registered.
    if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) throw new HttpError(401, 'wrong email or password')
    if (u.disabled) throw new HttpError(403, 'this account has been disabled')
    await q('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id])
    res.json(session(u))
  }))

  r.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }))

  r.patch('/me', requireAuth, h(async (req, res) => {
    const name = str(req.body.name, 40)?.trim()
    if (!name) throw bad('name required')
    const u = await one('UPDATE users SET name = $2 WHERE id = $1 RETURNING *', [req.user.id, name])
    res.json({ user: publicUser(u) })
  }))

  // Changing the password signs out every other device; this one gets a fresh token.
  r.post('/password', requireAuth, limiter, h(async (req, res) => {
    if (!(await bcrypt.compare(String(req.body.current || ''), req.user.password_hash))) throw new HttpError(401, 'current password is wrong')
    const password = checkPassword(req.body.password)
    const u = await one(
      'UPDATE users SET password_hash = $2, token_version = token_version + 1 WHERE id = $1 RETURNING *',
      [req.user.id, await bcrypt.hash(password, 11)])
    res.json(session(u))
  }))

  r.post('/logout-all', requireAuth, h(async (req, res) => {
    await q('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [req.user.id])
    res.json({ ok: true })
  }))

  // Deletes the account and, by cascade, every record it owns.
  r.delete('/me', requireAuth, limiter, h(async (req, res) => {
    if (!(await bcrypt.compare(String(req.body.password || ''), req.user.password_hash))) throw new HttpError(401, 'password is wrong')
    await q('DELETE FROM users WHERE id = $1', [req.user.id])
    res.json({ ok: true })
  }))

  return r
}
