// Rows ⇄ the state object the app renders (`S`). Reads assemble one user's records into S;
// writes take one record at a time, sanitise it and store it as rows. The logic modules
// (progression, stats, nutrition) all run over the assembled S.
import { q, one, tx } from './db.js'
import { useCustom } from './logic/exercises.js'
import { todayISO } from './logic/format.js'
import { bad, id, isoDate, num, str, json } from './http.js'

const J = v => (v == null ? null : JSON.stringify(v))

/* ============================ settings ============================ */

// Preferences the app keeps outside the record collections. Anything else sent is ignored.
export const SETTING_KEYS = {
  unit: v => (v === 'lb' ? 'lb' : 'kg'),
  restSec: v => num(v, { min: 10, max: 900 }) ?? 90,
  sound: v => !!v,
  keepAwake: v => !!v,
  lang: v => str(v, 8) || 'en',
  theme: v => (v === 'light' ? 'light' : 'dark'),
  accent: v => str(v, 16),
  body: v => (v === 'female' ? 'female' : 'male'),
  targetW: v => num(v, { min: 0, max: 2000 }),
  gifSize: v => (v === 'mini' ? 'mini' : 'full'),
  effort: v => (['none', 'rir', 'rpe'].includes(v) ? v : null),
  showRir: v => !!v,
  showFood: v => v !== false,
  reminder: v => (v && typeof v === 'object'
    ? { on: !!v.on, time: /^\d{2}:\d{2}$/.test(v.time) ? v.time : '08:00', tz: str(v.tz, 64) }
    : null),
  // The AI Coach is not offered by this backend; its namespace is kept so nothing is lost.
  coach: v => json(v, 256 * 1024, 'coach'),
  foodGoals: v => (v && typeof v === 'object'
    ? { kcal: num(v.kcal, { min: 0, max: 20000 }), p: num(v.p, { min: 0, max: 2000 }), c: num(v.c, { min: 0, max: 3000 }), f: num(v.f, { min: 0, max: 2000 }) }
    : null),
  foodAiOk: v => !!v
}

export function cleanSettings(patch) {
  const out = {}
  for (const k in patch || {}) if (SETTING_KEYS[k]) out[k] = SETTING_KEYS[k](patch[k])
  return out
}

export async function patchSettings(uid, patch, db = { q, one }) {
  const clean = cleanSettings(patch)
  const unset = Object.keys(patch || {}).filter(k => SETTING_KEYS[k] && patch[k] === null)
  await db.q(
    `INSERT INTO settings (user_id, data) VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET data = (settings.data || $2::jsonb) - $3::text[], updated_at = now()`,
    [uid, J(clean), unset])
  return clean
}

/* ============================ body weight ============================ */

export async function putBodyweight(uid, d, b, db = { q }) {
  const w = num(b.w, { min: 0.1, max: 2000 })
  if (w == null) throw bad('weight required')
  await db.q(
    `INSERT INTO bodyweight (user_id, d, w, t) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, d) DO UPDATE SET w = $3, t = $4`,
    [uid, isoDate(d), w, num(b.t) ?? Date.now()])
}
export const delBodyweight = (uid, d) => q('DELETE FROM bodyweight WHERE user_id = $1 AND d = $2', [uid, isoDate(d)])

/* ============================ plan ============================ */

export async function putRoutine(uid, rid, r, db = { q }) {
  if (!Array.isArray(r.ex)) throw bad('routine exercises required')
  const { id: _i, pos, name, emoji, prog, ex, ...extra } = r
  await db.q(
    `INSERT INTO routines (user_id, id, pos, name, emoji, prog, ex, extra) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
     ON CONFLICT (user_id, id) DO UPDATE SET pos=$3, name=$4, emoji=$5, prog=$6, ex=$7::jsonb, extra=$8::jsonb`,
    [uid, id(rid), num(pos, { min: 0, max: 10000 }) ?? 0, str(name, 80) || 'Routine', str(emoji, 40), str(prog, 20),
      J(json(ex, 64 * 1024, 'routine')), Object.keys(extra).length ? J(json(extra, 16 * 1024)) : null])
}
export async function delRoutine(uid, rid) {
  await tx(async t => {
    await t.q('DELETE FROM routines WHERE user_id = $1 AND id = $2', [uid, id(rid)])
    // a schedule pointing at a deleted routine would render as a ghost workout day
    await t.q('DELETE FROM week_plan WHERE user_id = $1 AND routine_id = $2', [uid, rid])
    await t.q('DELETE FROM day_plan WHERE user_id = $1 AND value = $2', [uid, rid])
  })
}

export async function putWeek(uid, week, db = { q }) {
  await db.q('DELETE FROM week_plan WHERE user_id = $1', [uid])
  for (const [k, rid] of Object.entries(week || {})) {
    const wd = +k
    if (!(wd >= 0 && wd <= 6) || !rid) continue
    await db.q('INSERT INTO week_plan (user_id, weekday, routine_id) VALUES ($1,$2,$3)', [uid, wd, id(rid, 'routine id')])
  }
}

export async function putDay(uid, d, value, db = { q }) {
  await db.q(
    `INSERT INTO day_plan (user_id, d, value) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, d) DO UPDATE SET value = $3`, [uid, isoDate(d), id(value, 'routine id')])
}
export const delDay = (uid, d) => q('DELETE FROM day_plan WHERE user_id = $1 AND d = $2', [uid, isoDate(d)])

export async function putExWeight(uid, exId, v, db = { q }) {
  const w = num(v.w, { min: 0, max: 5000 })
  if (w == null) throw bad('weight required')
  await db.q(
    `INSERT INTO exercise_weights (user_id, ex_id, w, d) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, ex_id) DO UPDATE SET w = $3, d = $4`,
    [uid, id(exId, 'exercise id'), w, v.d ? isoDate(v.d) : null])
}
export const delExWeight = (uid, exId) => q('DELETE FROM exercise_weights WHERE user_id = $1 AND ex_id = $2', [uid, id(exId)])

export async function putCustomEx(uid, cid, c, db = { q }) {
  const data = {
    n: str(c.n, 80) || 'Exercise', bp: str(c.bp, 40) || '', tg: str(c.tg, 40) || '', eq: str(c.eq, 40) || 'custom',
    custom: true, ...(c.desc ? { desc: str(c.desc, 2000) } : {})
  }
  await db.q(
    `INSERT INTO custom_exercises (user_id, id, data) VALUES ($1,$2,$3::jsonb)
     ON CONFLICT (user_id, id) DO UPDATE SET data = $3::jsonb`, [uid, id(cid), J(data)])
}
export const delCustomEx = (uid, cid) => q('DELETE FROM custom_exercises WHERE user_id = $1 AND id = $2', [uid, id(cid)])

/* ============================ workouts ============================ */

const SET_COLS = ['w', 'r', 'sec', 'min', 'speed', 'rir', 'rpe']

/** Replace one finished workout (and all its entries and sets). */
export async function putWorkout(uid, w, db) {
  if (!db) return tx(t => putWorkout(uid, w, t))
  const wid = id(w.id, 'workout id')
  if (!Array.isArray(w.entries)) throw bad('workout entries required')
  json(w, 512 * 1024, 'workout')
  const { id: _i, d, start, end, routineId, name, bw, vol, prs, rating, note, entries, ...extra } = w
  await db.q('DELETE FROM workouts WHERE user_id = $1 AND id = $2', [uid, wid])
  await db.q(
    `INSERT INTO workouts (user_id, id, d, start_ms, end_ms, routine_id, name, bw, vol, prs, rating, note, extra)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb)`,
    [uid, wid, isoDate(d), num(start), num(end), routineId ? str(routineId, 80) : null, str(name, 120) || '',
      num(bw, { min: 0, max: 2000 }), num(vol, { min: 0 }) ?? 0, J(Array.isArray(prs) ? prs.map(String).slice(0, 200) : []),
      str(rating, 16), str(note, 300), Object.keys(extra).length ? J(extra) : null])
  for (let i = 0; i < entries.length; i++) {
    const { id: exId, target, topW, sets, ...eExtra } = entries[i] || {}
    await db.q(
      `INSERT INTO workout_entries (user_id, workout_id, pos, ex_id, target, top_w, extra) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`,
      [uid, wid, i, id(exId, 'exercise id'), J(target || null), num(topW), Object.keys(eExtra).length ? J(eExtra) : null])
    const list = Array.isArray(sets) ? sets : []
    if (!list.length) continue
    // one multi-row insert per entry
    const vals = [], params = []
    list.forEach((s, j) => {
      const { done, ...rest } = s || {}
      const cols = SET_COLS.map(k => num(rest[k]))
      SET_COLS.forEach(k => delete rest[k])
      const base = params.length
      params.push(uid, wid, i, j, !!done, ...cols, Object.keys(rest).length ? J(rest) : null)
      vals.push('(' + Array.from({ length: 13 }, (_, k) => '$' + (base + k + 1) + (k === 12 ? '::jsonb' : '')).join(',') + ')')
    })
    await db.q(
      `INSERT INTO workout_sets (user_id, workout_id, entry_pos, pos, done, ${SET_COLS.join(', ')}, extra) VALUES ${vals.join(',')}`,
      params)
  }
}
export const delWorkout = (uid, wid) => q('DELETE FROM workouts WHERE user_id = $1 AND id = $2', [uid, id(wid)])

/** The in-progress session is a scratch document, saved whole as it changes. */
export async function putActive(uid, a, db = { q }) {
  if (!a || typeof a !== 'object' || !Array.isArray(a.entries)) throw bad('active workout required')
  await db.q(
    `INSERT INTO active_workouts (user_id, data) VALUES ($1,$2::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET data = $2::jsonb, updated_at = now()`, [uid, J(json(a, 512 * 1024, 'workout'))])
}
export const delActive = (uid, db = { q }) => db.q('DELETE FROM active_workouts WHERE user_id = $1', [uid])

/* ============================ food ============================ */

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack']
export function cleanPer100(p) {
  const out = {}
  for (const k in p || {}) {
    if (!/^[a-zA-Z0-9]{1,8}$/.test(k)) continue
    const v = num(p[k], { min: 0, max: 100000 })
    if (v != null) out[k] = v
  }
  return out
}

export async function putFoodEntry(uid, fid, e, db = { q }) {
  const g = num(e.g, { min: 1, max: 100000 })
  if (g == null) throw bad('grams required')
  await db.q(
    `INSERT INTO food_log (user_id, id, d, t, meal, name, g, src, fid, food, per100, via)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
     ON CONFLICT (user_id, id) DO UPDATE SET d=$3, t=$4, meal=$5, name=$6, g=$7, src=$8, fid=$9, food=$10, per100=$11::jsonb, via=$12`,
    [uid, id(fid), isoDate(e.d), num(e.t) ?? Date.now(), MEALS.includes(e.meal) ? e.meal : 'snack',
      str(e.name, 80) || 'Food', Math.round(g), str(e.src, 16), e.fid == null ? null : str(e.fid, 40), str(e.food, 200),
      J(cleanPer100(e.per100)), str(e.via, 16)])
}
export const delFoodEntry = (uid, fid) => q('DELETE FROM food_log WHERE user_id = $1 AND id = $2', [uid, id(fid)])

export async function putCustomFood(uid, cid, c, db = { q }) {
  await db.q(
    `INSERT INTO custom_foods (user_id, id, name, serving, per100, from_ref) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)
     ON CONFLICT (user_id, id) DO UPDATE SET name=$3, serving=$4, per100=$5::jsonb, from_ref=$6::jsonb`,
    [uid, id(cid), str(c.name, 80) || 'Food', num(c.serving, { min: 1, max: 100000 }) ?? 100,
      J(cleanPer100(c.per100)), J(json(c.from ?? null, 4096))])
}
export const delCustomFood = (uid, cid) => q('DELETE FROM custom_foods WHERE user_id = $1 AND id = $2', [uid, id(cid)])

/* ============================ read: rows → S ============================ */

export async function loadWorkouts(uid, db = { q }) {
  const [ws, es, ss] = await Promise.all([
    db.q('SELECT * FROM workouts WHERE user_id = $1 ORDER BY d, start_ms NULLS FIRST, created_at', [uid]),
    db.q('SELECT workout_id, pos, ex_id, target, top_w, extra FROM workout_entries WHERE user_id = $1 ORDER BY workout_id, pos', [uid]),
    db.q(`SELECT workout_id, entry_pos, pos, done, ${SET_COLS.join(', ')}, extra FROM workout_sets WHERE user_id = $1 ORDER BY workout_id, entry_pos, pos`, [uid])
  ])
  const byW = new Map()
  for (const w of ws) {
    byW.set(w.id, {
      id: w.id, d: w.d, start: w.start_ms, end: w.end_ms, routineId: w.routine_id, name: w.name, bw: w.bw,
      vol: w.vol, prs: w.prs || [], ...(w.rating ? { rating: w.rating } : {}), ...(w.note ? { note: w.note } : {}),
      ...(w.extra || {}), entries: []
    })
  }
  for (const e of es) {
    const w = byW.get(e.workout_id)
    if (w) w.entries[e.pos] = { id: e.ex_id, ...(e.extra || {}), sets: [], topW: e.top_w, target: e.target }
  }
  for (const s of ss) {
    const en = byW.get(s.workout_id)?.entries[s.entry_pos]
    if (!en) continue
    const set = { ...(s.extra || {}) }
    for (const k of SET_COLS) if (s[k] != null) set[k] = s[k]
    set.done = s.done
    en.sets[s.pos] = set
  }
  const out = [...byW.values()]
  out.forEach(w => { w.entries = w.entries.filter(Boolean); w.entries.forEach(e => { e.sets = e.sets.filter(Boolean) }) })
  return out
}

/**
 * Everything one user has, as the app's state object. Also scopes the user's custom
 * exercises into EXIDX for the rest of the request, so logic run over S sees them.
 */
export async function loadState(uid, { tz } = {}) {
  const [set, bw, routines, week, days, exw, cex, workouts, active, food, cfood] = await Promise.all([
    one('SELECT data FROM settings WHERE user_id = $1', [uid]),
    q('SELECT d, w, t FROM bodyweight WHERE user_id = $1 ORDER BY d', [uid]),
    q('SELECT id, name, emoji, prog, ex, extra FROM routines WHERE user_id = $1 ORDER BY pos, id', [uid]),
    q('SELECT weekday, routine_id FROM week_plan WHERE user_id = $1', [uid]),
    q('SELECT d, value FROM day_plan WHERE user_id = $1', [uid]),
    q('SELECT ex_id, w, d FROM exercise_weights WHERE user_id = $1', [uid]),
    q('SELECT id, data FROM custom_exercises WHERE user_id = $1 ORDER BY id', [uid]),
    loadWorkouts(uid),
    one('SELECT data FROM active_workouts WHERE user_id = $1', [uid]),
    q('SELECT id, d, t, meal, name, g, src, fid, food, per100, via FROM food_log WHERE user_id = $1 ORDER BY d, t', [uid]),
    q('SELECT id, name, serving, per100, from_ref FROM custom_foods WHERE user_id = $1 ORDER BY name', [uid])
  ])
  const prefs = { ...(set?.data || {}) }
  const { foodGoals, foodAiOk, ...rest } = prefs
  const customEx = cex.map(c => ({ id: c.id, ...c.data }))
  useCustom(customEx)
  const S = {
    unit: 'kg', ...rest,
    bodyweight: bw.map(b => ({ d: b.d, w: b.w, ...(b.t != null ? { t: b.t } : {}) })),
    routines: routines.map(r => ({ id: r.id, name: r.name, emoji: r.emoji, ...(r.prog ? { prog: r.prog } : {}), ...(r.extra || {}), ex: r.ex || [] })),
    week: Object.fromEntries(week.map(w => [w.weekday, w.routine_id])),
    dayPlan: Object.fromEntries(days.map(d => [d.d, d.value])),
    exWeights: Object.fromEntries(exw.map(e => [e.ex_id, { w: e.w, ...(e.d ? { d: e.d } : {}) }])),
    customEx,
    workouts,
    active: active?.data || null,
    food: food.length || cfood.length || foodGoals || foodAiOk ? {
      log: food.map(f => ({ id: f.id, d: f.d, t: f.t, meal: f.meal, name: f.name, g: f.g, src: f.src, fid: f.fid, food: f.food, per100: f.per100 || {}, via: f.via })),
      custom: cfood.map(c => ({ id: c.id, name: c.name, serving: c.serving, per100: c.per100 || {}, from: c.from_ref })),
      goals: foodGoals || null,
      ...(foodAiOk ? { aiOk: true } : {})
    } : null
  }
  // Not stored: the user's own date, for "today" / "this week" logic (see history.streakWeeks).
  Object.defineProperty(S, 'today', { value: todayISO(tz || S.reminder?.tz), enumerable: false })
  return S
}

/* ============================ server-side changes ============================ */

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const byKey = (list, key = 'id') => new Map((list || []).map(x => [x[key], x]))

/**
 * Store what changed between two versions of S, in one transaction. Used by server actions
 * that run the app's merge logic over the whole state (starter plan, shared-plan import,
 * CSV import) — only touched records are written.
 */
export async function saveChanges(uid, a, b) {
  await tx(async t => {
    const coll = async (la, lb, put, del, key = 'id') => {
      const A = byKey(la, key), B = byKey(lb, key)
      for (const [k, v] of B) if (!same(A.get(k), v)) await put(k, v)
      for (const k of A.keys()) if (!B.has(k)) await del(k)
    }
    await coll(a.bodyweight, b.bodyweight, (d, v) => putBodyweight(uid, d, v, t),
      d => t.q('DELETE FROM bodyweight WHERE user_id = $1 AND d = $2', [uid, d]), 'd')
    const posA = new Map((a.routines || []).map((r, i) => [r.id, i]))
    const ra = byKey(a.routines)
    for (const [i, r] of (b.routines || []).entries()) {
      if (!same(ra.get(r.id), r) || posA.get(r.id) !== i) await putRoutine(uid, r.id, { ...r, pos: i }, t)
    }
    for (const r of a.routines || []) if (!(b.routines || []).some(x => x.id === r.id)) await t.q('DELETE FROM routines WHERE user_id = $1 AND id = $2', [uid, r.id])
    if (!same(a.week, b.week)) await putWeek(uid, b.week, t)
    await coll(Object.entries(a.dayPlan || {}).map(([d, v]) => ({ d, v })), Object.entries(b.dayPlan || {}).map(([d, v]) => ({ d, v })),
      (d, x) => putDay(uid, d, x.v, t), d => t.q('DELETE FROM day_plan WHERE user_id = $1 AND d = $2', [uid, d]), 'd')
    await coll(Object.entries(a.exWeights || {}).map(([id, v]) => ({ id, ...v })), Object.entries(b.exWeights || {}).map(([id, v]) => ({ id, ...v })),
      (k, v) => putExWeight(uid, k, v, t), k => t.q('DELETE FROM exercise_weights WHERE user_id = $1 AND ex_id = $2', [uid, k]))
    await coll(a.customEx, b.customEx, (k, v) => putCustomEx(uid, k, v, t),
      k => t.q('DELETE FROM custom_exercises WHERE user_id = $1 AND id = $2', [uid, k]))
    await coll(a.workouts, b.workouts, (k, v) => putWorkout(uid, v, t),
      k => t.q('DELETE FROM workouts WHERE user_id = $1 AND id = $2', [uid, k]))
  })
}

/* ============================ whole-state replace (backup import, reset) ============================ */

const TABLES = ['bodyweight', 'routines', 'week_plan', 'day_plan', 'exercise_weights', 'custom_exercises', 'workouts',
  'active_workouts', 'food_log', 'custom_foods', 'settings']

export async function wipe(uid, t) {
  for (const tbl of TABLES) await t.q(`DELETE FROM ${tbl} WHERE user_id = $1`, [uid])
}

/** Replace everything with a backup file's contents (the app's export format). */
export async function replaceAll(uid, S) {
  json(S, 20 * 1024 * 1024, 'backup')
  await tx(async t => {
    await wipe(uid, t)
    const prefs = {}
    for (const k in SETTING_KEYS) if (S[k] !== undefined) prefs[k] = S[k]
    if (S.food?.goals) prefs.foodGoals = S.food.goals
    if (S.food?.aiOk) prefs.foodAiOk = true
    await patchSettings(uid, prefs, t)
    for (const b of S.bodyweight || []) await putBodyweight(uid, b.d, b, t)
    let pos = 0
    for (const r of S.routines || []) await putRoutine(uid, r.id, { ...r, pos: pos++ }, t)
    await putWeek(uid, S.week || {}, t)
    for (const [d, v] of Object.entries(S.dayPlan || {})) await putDay(uid, d, v, t)
    for (const [ex, v] of Object.entries(S.exWeights || {})) if (v && v.w != null) await putExWeight(uid, ex, v, t)
    for (const c of S.customEx || []) await putCustomEx(uid, c.id, c, t)
    for (const w of S.workouts || []) await putWorkout(uid, w, t)
    for (const e of S.food?.log || []) await putFoodEntry(uid, e.id, e, t)
    for (const c of S.food?.custom || []) await putCustomFood(uid, c.id, c, t)
  })
}
