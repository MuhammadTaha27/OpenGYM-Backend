// Admin dashboard: every account at a glance, one account's history, disabling an account.
// Admins are users with is_admin set, or whose email is listed in ADMIN_EMAILS.
import { Router } from 'express'
import { h, HttpError, id } from '../http.js'
import { q, one } from '../db.js'
import { isAdmin } from '../auth.js'
import { loadWorkouts } from '../state.js'
import { livePresence, dropPresence } from './push.js'
import { mealsConfig } from './insights.js'

export function adminRoutes() {
  const r = Router()

  r.get('/users', h(async (req, res) => {
    const rows = await q(`
      SELECT u.*,
        (SELECT count(*) FROM workouts w WHERE w.user_id = u.id) AS n_workouts,
        (SELECT max(d) FROM workouts w WHERE w.user_id = u.id) AS last_workout,
        (SELECT updated_at FROM settings s WHERE s.user_id = u.id) AS settings_at,
        EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = u.id) AS has_push
      FROM users u ORDER BY u.created_at`)
    res.json({
      users: rows.map(u => ({
        id: u.id, name: u.name, email: u.email, created: u.created_at, disabled: u.disabled, admin: isAdmin(u),
        workouts: u.n_workouts, lastWorkout: u.last_workout,
        lastSync: u.last_login_at || u.settings_at ? Math.max(+new Date(u.last_login_at || 0), +new Date(u.settings_at || 0)) : null,
        hasPush: u.has_push, live: livePresence(u.id)
      })),
      invite_only: false,
      now: Date.now()
    })
  }))

  r.get('/user', h(async (req, res) => {
    const u = await one('SELECT * FROM users WHERE id = $1', [id(req.query.id)])
    if (!u) throw new HttpError(404, 'no such user')
    const [set, routines, bodyweight, workouts] = await Promise.all([
      one('SELECT data, updated_at FROM settings WHERE user_id = $1', [u.id]),
      q('SELECT id, name, emoji, jsonb_array_length(ex) AS count FROM routines WHERE user_id = $1 ORDER BY pos', [u.id]),
      q('SELECT d, w, t FROM bodyweight WHERE user_id = $1 ORDER BY d', [u.id]),
      loadWorkouts(u.id)
    ])
    res.json({
      user: { id: u.id, name: u.name, email: u.email, created: u.created_at, disabled: u.disabled, admin: isAdmin(u) },
      unit: set?.data?.unit || 'kg',
      lastSync: set ? +new Date(set.updated_at) : null,
      routines, bodyweight,
      workouts: workouts.reverse()
    })
  }))

  r.post('/user/disable', h(async (req, res) => {
    const u = await one('SELECT * FROM users WHERE id = $1', [id(req.body.id)])
    if (!u) throw new HttpError(404, 'no such user')
    if (isAdmin(u)) throw new HttpError(400, 'cannot disable an admin')
    const disabled = !!req.body.disabled
    await q('UPDATE users SET disabled = $2 WHERE id = $1', [u.id, disabled])
    if (disabled) dropPresence(u.id)
    res.json({ ok: true, id: u.id, disabled })
  }))

  // AI meal analysis is configured through the environment on a hosted server; this reports it.
  r.get('/meals', h(async (req, res) => {
    const c = mealsConfig()
    const used = await one('SELECT coalesce(sum(n), 0) AS n FROM ai_usage WHERE day = $1', [new Date().toISOString().slice(0, 10)])
    res.json({ enabled: c.on, model: c.model, key: c.key ? { last4: c.key.slice(-4) } : null, caps: { perProfileDaily: c.perUserDaily }, usedToday: used.n })
  }))

  return r
}
