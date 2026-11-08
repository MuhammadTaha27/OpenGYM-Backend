// Web Push (rest-timer alerts, the workout-day reminder) and live presence for the admin
// dashboard. Push needs VAPID keys in the environment (npm run vapid prints a pair); without
// them every push endpoint answers 503 and the rest of the app is unaffected.
//
// Free hosting note: a server that sleeps when idle (Render's free tier) also sleeps through
// the reminder minute. The ticker below catches up on the next wake within the same day.
import { Router } from 'express'
import * as webpush from 'web-push'
import { h, HttpError, num, str } from '../http.js'
import { q, one } from '../db.js'
import { effectiveRoutineId } from '../logic/history.js'

const VAPID = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
  ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY } : null
if (VAPID) webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', VAPID.publicKey, VAPID.privateKey)

export async function sendPush(userId, payload) {
  if (!VAPID) return
  const subs = await q('SELECT endpoint, keys FROM push_subscriptions WHERE user_id = $1', [userId])
  await Promise.all(subs.map(async s => {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload), { urgency: 'high' }) }
    catch (e) {
      console.error('push send failed', userId, e.statusCode, e.body || e.message)
      if (e.statusCode === 404 || e.statusCode === 410) await q('DELETE FROM push_subscriptions WHERE endpoint = $1', [s.endpoint])
    }
  }))
}

// Rest timer: the app schedules on start and cancels when the rest ends on screen — this only
// fires when the app was backgrounded and never got to cancel it.
const restTimers = new Map()
const cancelRest = uid => { const t = restTimers.get(uid); if (t) { clearTimeout(t); restTimers.delete(uid) } }

/* ---------- live presence (in memory, never stored) ---------- */
const presence = new Map()
const PRESENCE_TTL = 70000
export function livePresence(uid) {
  const p = presence.get(uid)
  if (!p) return null
  if (Date.now() - p.updatedAt > PRESENCE_TTL) { presence.delete(uid); return null }
  return p
}
export const dropPresence = uid => presence.delete(uid)

export function pushRoutes() {
  const r = Router()
  const need = () => { if (!VAPID) throw new HttpError(503, 'push notifications are not set up on this server') }

  r.get('/push/public-key', h(async (req, res) => { need(); res.json({ key: VAPID.publicKey }) }))

  r.post('/push/subscribe', h(async (req, res) => {
    need()
    const sub = req.body.subscription
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new HttpError(400, 'invalid subscription')
    await q(
      `INSERT INTO push_subscriptions (endpoint, user_id, keys) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = $2, keys = $3::jsonb`,
      [str(sub.endpoint, 1000), req.user.id, JSON.stringify({ p256dh: str(sub.keys.p256dh, 200), auth: str(sub.keys.auth, 200) })])
    res.json({ ok: true })
  }))

  r.post('/push/unsubscribe', h(async (req, res) => {
    await q('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [req.user.id, String(req.body.endpoint || '')])
    res.json({ ok: true })
  }))

  r.post('/push/test', h(async (req, res) => {
    need()
    await sendPush(req.user.id, { title: 'openGym', body: 'Test notification ✅ — this is what alerts look like.', tag: 'test' })
    res.json({ ok: true })
  }))

  r.post('/push/rest-timer', h(async (req, res) => {
    const sec = Math.round(num(req.body.seconds, { min: 1, max: 3600 }) || 0)
    if (!sec) throw new HttpError(400, 'seconds required')
    const uid = req.user.id
    cancelRest(uid)
    restTimers.set(uid, setTimeout(() => {
      restTimers.delete(uid)
      sendPush(uid, { title: 'Rest over 💪', body: 'Time for your next set.', tag: 'rest-timer' })
    }, sec * 1000))
    res.json({ ok: true })
  }))
  r.post('/push/rest-timer/cancel', h(async (req, res) => { cancelRest(req.user.id); res.json({ ok: true }) }))

  // Heartbeat while a workout is on screen; { active: false } drops it.
  r.post('/activity', h(async (req, res) => {
    const b = req.body
    if (b.active) {
      presence.set(req.user.id, {
        name: str(b.name, 60) || '', exIdx: num(b.exIdx) || 0, exTotal: num(b.exTotal) || 0,
        setsDone: num(b.setsDone) || 0, setsTotal: num(b.setsTotal) || 0,
        startedAt: num(b.startedAt) || Date.now(), updatedAt: Date.now()
      })
    } else presence.delete(req.user.id)
    res.json({ ok: true })
  }))

  return r
}

/* ---------- workout-day reminder ---------- */

// "Now" in the user's own zone, so the reminder fires by their clock wherever they are.
function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date())
    const g = t => parts.find(p => p.type === t)?.value
    return { date: `${g('year')}-${g('month')}-${g('day')}`, hhmm: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` }
  } catch { return null }
}

export async function reminderTick() {
  if (!VAPID) return
  const due = await q(
    `SELECT u.id, u.last_reminder, s.data->'reminder' AS rem FROM users u
     JOIN settings s ON s.user_id = u.id
     WHERE NOT u.disabled AND (s.data->'reminder'->>'on')::boolean IS TRUE
       AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = u.id)`)
  for (const u of due) {
    const now = userNow(u.rem.tz || 'UTC')
    // At or after the chosen time, once per day — a server that slept through the minute
    // still sends it when it wakes, as long as it's the same day.
    if (!now || now.hhmm < (u.rem.time || '08:00') || u.last_reminder === now.date) continue
    if (await one('SELECT 1 FROM workouts WHERE user_id = $1 AND d = $2', [u.id, now.date])) continue
    const [routines, week, day] = await Promise.all([
      q('SELECT id, name, emoji FROM routines WHERE user_id = $1', [u.id]),
      q('SELECT weekday, routine_id FROM week_plan WHERE user_id = $1', [u.id]),
      one('SELECT value FROM day_plan WHERE user_id = $1 AND d = $2', [u.id, now.date])
    ])
    const S = {
      routines, week: Object.fromEntries(week.map(w => [w.weekday, w.routine_id])),
      dayPlan: day ? { [now.date]: day.value } : {}
    }
    await q('UPDATE users SET last_reminder = $2 WHERE id = $1', [u.id, now.date])
    const rid = effectiveRoutineId(S, now.date)
    if (!rid) continue
    const routine = routines.find(x => x.id === rid)
    await sendPush(u.id, {
      title: routine ? `${routine.name} today` : 'Workout planned today',
      body: "It's on your plan — let's go 💪",
      tag: 'day-reminder'
    })
  }
}
