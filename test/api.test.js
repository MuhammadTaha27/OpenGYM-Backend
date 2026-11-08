import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './helpers.js'

let srv
before(async () => { srv = await startServer() })
after(async () => { await srv?.stop() })

test('signup, login, me — and the obvious ways to get it wrong', async () => {
  const { call } = srv
  const r = await call('POST /auth/signup', { email: 'Taha@Example.com', password: 'hunter2222', name: 'Taha' })
  assert.equal(r.status, 201)
  assert.equal(r.body.user.email, 'taha@example.com')
  assert.ok(r.body.token)

  assert.equal((await call('POST /auth/signup', { email: 'taha@example.com', password: 'another-pass' })).status, 409)
  assert.equal((await call('POST /auth/signup', { email: 'not-an-email', password: 'hunter2222' })).status, 400)
  assert.equal((await call('POST /auth/signup', { email: 'x@example.com', password: 'short' })).status, 400)

  assert.equal((await call('POST /auth/login', { email: 'taha@example.com', password: 'wrong-pass' })).status, 401)
  const login = await call('POST /auth/login', { email: ' TAHA@example.com ', password: 'hunter2222' })
  assert.equal(login.status, 200)

  const me = await call('GET /auth/me', undefined, login.body.token)
  assert.equal(me.body.user.name, 'Taha')
  assert.equal((await call('GET /auth/me')).status, 401)
  assert.equal((await call('GET /state', undefined, 'garbage')).status, 401)
})

test('sign out everywhere and password change revoke old tokens', async () => {
  const { call, signup } = srv
  const { token, user } = await signup()
  assert.equal((await call('POST /auth/logout-all', {}, token)).status, 200)
  assert.equal((await call('GET /auth/me', undefined, token)).status, 401)

  const t2 = (await call('POST /auth/login', { email: user.email, password: 'correct horse' })).body.token
  const changed = await call('POST /auth/password', { current: 'correct horse', password: 'battery staple' }, t2)
  assert.equal(changed.status, 200)
  assert.equal((await call('GET /auth/me', undefined, t2)).status, 401)
  assert.equal((await call('GET /auth/me', undefined, changed.body.token)).status, 200)
})

test('records are stored per user and come back in the app’s state shape', async () => {
  const { call, signup } = srv
  const a = (await signup()).token
  const b = (await signup()).token

  assert.equal((await call('PATCH /settings', { unit: 'lb', restSec: 120, targetW: 170, bogus: 1 }, a)).status, 200)
  await call('PUT /bodyweight/2026-11-01', { w: 180.4 }, a)
  await call('PUT /bodyweight/2026-11-02', { w: 179.9 }, a)
  await call('PUT /bodyweight/2026-11-02', { w: 179.5 }, a)        // same day → replaces
  await call('PUT /routines/r1', { name: 'Push', emoji: 'barbell', ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }] }, a)
  await call('PUT /plan/week', { week: { 1: 'r1' } }, a)
  await call('PUT /plan/days/2026-11-05', { value: 'rest' }, a)
  await call('PUT /food/log/f1', { d: '2026-11-02', meal: 'lunch', name: 'Rice', g: 200, src: 'usda', per100: { kcal: 130, p: 2.7 } }, a)
  await call('PATCH /settings', { foodGoals: { kcal: 2500, p: 160, c: 250, f: 80 } }, a)

  const S = (await call('GET /state', undefined, a)).body.state
  // epoch-ms timestamps survive the round trip unclamped
  assert.ok(S.bodyweight[0].t > 1.7e12, 'weigh-in time stored as given')
  assert.ok(S.food.log[0].t > 1.7e12, 'food entry time stored as given')
  assert.equal(S.unit, 'lb')
  assert.equal(S.restSec, 120)
  assert.equal(S.bogus, undefined)
  assert.deepEqual(S.bodyweight.map(x => [x.d, x.w]), [['2026-11-01', 180.4], ['2026-11-02', 179.5]])
  assert.equal(S.routines[0].ex[0].reps, 8)
  assert.deepEqual(S.week, { 1: 'r1' })
  assert.deepEqual(S.dayPlan, { '2026-11-05': 'rest' })
  assert.equal(S.food.log[0].name, 'Rice')
  assert.equal(S.food.goals.kcal, 2500)

  // the other account sees none of it
  const Sb = (await call('GET /state', undefined, b)).body.state
  assert.equal(Sb.bodyweight.length, 0)
  assert.equal(Sb.routines.length, 0)
  assert.equal(Sb.food, null)

  // deleting a routine also clears the schedule that pointed at it
  await call('DELETE /routines/r1', undefined, a)
  const S2 = (await call('GET /state', undefined, a)).body.state
  assert.deepEqual(S2.week, {})
})

test('invalid input is refused, not stored', async () => {
  const { call, signup } = srv
  const t = (await signup()).token
  assert.equal((await call('PUT /bodyweight/yesterday', { w: 80 }, t)).status, 400)
  assert.equal((await call('PUT /bodyweight/2026-11-01', { w: 'heavy' }, t)).status, 400)
  assert.equal((await call('PUT /routines/bad%20id!', { name: 'x', ex: [] }, t)).status, 400)
  assert.equal((await call('PUT /routines/r1', { name: 'x', ex: 'not a list' }, t)).status, 400)
  assert.equal((await call('PUT /workouts/w1', { id: 'w1', d: '2026-11-01', entries: [{ id: '../../etc', sets: [] }] }, t)).status, 400)
  // a failed workout write leaves nothing half-stored
  assert.equal((await call('GET /state', undefined, t)).body.state.workouts.length, 0)
  assert.equal((await call('PUT /food/log/f1', { d: '2026-11-01', name: 'x', g: 'lots' }, t)).status, 400)
})

test('a workout: server builds the session, finishing logs every set and finds PRs', async () => {
  const { call, signup } = srv
  const t = (await signup()).token
  await call('PUT /routines/r1', { name: 'Push', ex: [{ id: '0025', sets: 2, reps: 5, weight: 60, mode: 'reps' }] }, t)

  // first session: baseline
  let { body: { active } } = await call('POST /workouts/active', { routineId: 'r1', bw: 80 }, t)
  assert.equal(active.name, 'Push')
  assert.equal(active.entries[0].plan.kind, 'first')
  assert.deepEqual(active.entries[0].sets.map(s => [s.w, s.r]), [[60, 5], [60, 5]])
  active.entries[0].sets.forEach(s => { s.done = true })
  // progress is saved as it goes
  assert.equal((await call('PUT /workouts/active', { active }, t)).status, 200)
  assert.equal((await call('GET /state', undefined, t)).body.state.active.entries[0].sets[0].done, true)

  let fin = (await call('POST /workouts/active/finish', {}, t)).body
  assert.equal(fin.workout.vol, 600)
  const stored = (await call('GET /state', undefined, t)).body.state.workouts[0]
  assert.equal(stored.start, active.start)
  assert.ok(stored.end >= stored.start && stored.end > 1.7e12)
  assert.deepEqual(fin.prs, ['0025'])
  assert.deepEqual(fin.exWeights, { '0025': { w: 60, d: fin.workout.d } })
  assert.ok(Object.keys(fin.load).length > 0)

  let S = (await call('GET /state', undefined, t)).body.state
  assert.equal(S.active, null)
  assert.equal(S.workouts.length, 1)
  assert.equal(S.workouts[0].entries[0].sets.length, 2)
  assert.equal(S.workouts[0].entries[0].target.reps, 5)

  // every rep hit → linear progression adds a step next time, and says why
  active = (await call('POST /workouts/active', { routineId: 'r1' }, t)).body.active
  assert.equal(active.entries[0].plan.kind, 'up')
  assert.equal(active.entries[0].sets[0].w, 62.5)
  assert.equal(active.entries[0].last.sets.length, 2)
  assert.equal(active.entries[0].best, 60)

  // add an exercise mid-session, sent with the client's own copy
  active.entries[0].sets[0].done = true
  const added = (await call('POST /workouts/active/entries', { active, cfg: { id: '0047', sets: 3, reps: 10, mode: 'reps' } }, t)).body.active
  assert.equal(added.entries.length, 2)
  assert.equal(added.entries[0].sets[0].done, true)
  assert.equal(added.cur, 1)

  fin = (await call('POST /workouts/active/finish', { active: added }, t)).body
  assert.deepEqual(fin.prs, ['0025'])                     // 62.5 > 60
  assert.equal(fin.workout.entries.length, 1)              // the untouched exercise isn't logged

  // a rating added afterwards is an edit of that workout
  const w = fin.workout
  assert.equal((await call(`PUT /workouts/${w.id}`, { ...w, rating: 'hard', note: 'tough' }, t)).status, 200)
  S = (await call('GET /state', undefined, t)).body.state
  assert.equal(S.workouts[1].rating, 'hard')
  assert.equal(S.workouts[1].entries[0].sets[0].w, 62.5)

  const stats = (await call('GET /stats', undefined, t)).body
  assert.equal(stats.tiles.workouts, 2)
  assert.deepEqual(stats.exercises.map(e => e.id), ['0025'])
  const ex = (await call('GET /stats/exercise/0025', undefined, t)).body
  assert.deepEqual(ex.points.map(p => p.y), [60, 62.5])
  assert.equal(ex.best, 62.5)

  const sum = (await call('GET /summary', undefined, t)).body
  assert.equal(sum.workouts, 2)
  assert.equal(sum.best['0025'], 62.5)
  assert.equal(sum.streak, 1)

  assert.equal((await call(`DELETE /workouts/${w.id}`, undefined, t)).status, 200)
  assert.equal((await call('GET /state', undefined, t)).body.state.workouts.length, 1)
})

test('custom exercises are resolved per user', async () => {
  const { call, signup } = srv
  const a = (await signup()).token
  const b = (await signup()).token
  await call('PUT /custom-exercises/myrow', { n: 'Rowing machine', bp: 'cardio' }, a)
  await call('PUT /routines/r1', { name: 'Cardio', ex: [{ id: 'myrow', sets: 1, min: 20, speed: 8 }] }, a)
  const act = (await call('POST /workouts/active', { routineId: 'r1' }, a)).body.active
  // a custom cardio exercise logs time + speed, because its body part says so
  assert.deepEqual(Object.keys(act.entries[0].sets[0]).sort(), ['done', 'min', 'speed'])
  // b can't start a's routine
  assert.equal((await call('POST /workouts/active', { routineId: 'r1' }, b)).status, 404)
})

test('food: search, day totals, recent, suggested goals', async () => {
  const { call, signup } = srv
  const t = (await signup()).token
  const s = (await call('GET /food/search?q=banana', undefined, t)).body
  assert.ok(s.foods.length > 0)
  assert.ok(s.foods[0].per100.kcal > 0)

  await call('PUT /food/log/a', { d: '2026-11-03', meal: 'breakfast', name: 'Banana', g: 120, src: 'usda', fid: s.foods[0].id, per100: { kcal: 89, p: 1.1 } }, t)
  await call('PUT /food/log/b', { d: '2026-11-03', meal: 'snack', name: 'Banana', g: 100, src: 'usda', fid: s.foods[0].id, per100: { kcal: 89, p: 1.1 } }, t)
  const day = (await call('GET /food/day?d=2026-11-03', undefined, t)).body
  assert.equal(day.count, 2)
  assert.equal(Math.round(day.n.kcal), Math.round(89 * 2.2))
  assert.equal((await call('GET /food/recent', undefined, t)).body.recent.length, 1)

  assert.equal((await call('GET /food/suggest-goals', undefined, t)).body.goals, null)
  await call('PUT /bodyweight/2026-11-03', { w: 80 }, t)
  assert.equal((await call('GET /food/suggest-goals', undefined, t)).body.goals.p, 144)

  await call('PUT /food/custom/c1', { name: 'Protein bar', serving: 60, per100: { kcal: 380, p: 33 } }, t)
  assert.equal((await call('GET /food/search?q=prot', undefined, t)).body.mine[0].name, 'Protein bar')

  // no Gemini key configured in tests
  assert.equal((await call('POST /meals/analyze', { text: 'a banana' }, t)).status, 503)
})

test('starter plan, plan share round-trip, CSV import, backup restore, reset', async () => {
  const { call, signup } = srv
  const t = (await signup()).token
  const st = (await call('POST /plan/starter', {}, t)).body.state
  assert.deepEqual(st.routines.map(r => r.name), ['Push Day', 'Pull Day', 'Leg Day'])
  assert.equal(Object.keys(st.week).length, 3)

  const bundle = (await call('GET /plan/export?name=mine', undefined, t)).body
  const other = (await signup()).token
  assert.equal((await call('POST /plan/parse', { bundle }, other)).body.routineCount, 3)
  const imp = (await call('POST /plan/import', { bundle, schedule: true }, other)).body.state
  assert.equal(imp.routines.length, 3)
  assert.equal(Object.keys(imp.week).length, 3)
  assert.equal((await call('POST /plan/parse', { bundle: { nope: 1 } }, other)).status, 400)

  const csv = 'Date,Exercise,Category,Weight,Weight Unit,Reps\n2026-10-01,Flat Barbell Bench Press,Chest,60,kgs,8\n2026-10-01,Flat Barbell Bench Press,Chest,60,kgs,8\n'
  const pre = (await call('POST /import/parse', { text: csv }, t)).body
  assert.equal(pre.kind, 'workouts')
  assert.equal(pre.fresh, 1)
  const com = (await call('POST /import/commit', { text: csv }, t)).body
  assert.equal(com.result.added, 1)
  assert.equal(com.state.workouts.length, 1)
  assert.equal((await call('POST /import/commit', { text: csv }, t)).body.result.added, 0)   // idempotent

  const backup = (await call('GET /data/export', undefined, t)).body
  const restored = (await call('POST /data/import', { state: backup }, other)).body.state
  assert.equal(restored.workouts.length, 1)
  assert.equal(restored.routines.length, 3)
  assert.deepEqual(restored.workouts[0].entries, backup.workouts[0].entries)

  const wiped = (await call('DELETE /data', undefined, t)).body.state
  assert.equal(wiped.routines.length + wiped.workouts.length + wiped.bodyweight.length, 0)
})

test('deleting the account removes everything it owned', async () => {
  const { call, signup } = srv
  const { token, user } = await signup()
  await call('PUT /bodyweight/2026-11-01', { w: 80 }, token)
  assert.equal((await call('DELETE /auth/me', { password: 'nope' }, token)).status, 401)
  assert.equal((await call('DELETE /auth/me', { password: 'correct horse' }, token)).status, 200)
  assert.equal((await call('POST /auth/login', { email: user.email, password: 'correct horse' })).status, 401)
})
