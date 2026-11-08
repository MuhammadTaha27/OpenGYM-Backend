// Plain record endpoints: one resource, one row (or document) per call. The app writes every
// change it makes through these — each weigh-in, routine edit, logged food — so nothing a
// user keeps lives only on their phone.
import { Router } from 'express'
import { h, bad } from '../http.js'
import * as st from '../state.js'

export function recordRoutes() {
  const r = Router()
  const ok = res => res.json({ ok: true })
  const uid = req => req.user.id

  /* settings */
  r.patch('/settings', h(async (req, res) => {
    if (!req.body || typeof req.body !== 'object') throw bad('settings required')
    res.json({ settings: await st.patchSettings(uid(req), req.body) })
  }))

  /* body weight — keyed by date, one weigh-in per day */
  r.put('/bodyweight/:d', h(async (req, res) => { await st.putBodyweight(uid(req), req.params.d, req.body); ok(res) }))
  r.delete('/bodyweight/:d', h(async (req, res) => { await st.delBodyweight(uid(req), req.params.d); ok(res) }))

  /* routines + schedule */
  r.put('/routines/:id', h(async (req, res) => { await st.putRoutine(uid(req), req.params.id, req.body); ok(res) }))
  r.delete('/routines/:id', h(async (req, res) => { await st.delRoutine(uid(req), req.params.id); ok(res) }))
  r.put('/plan/week', h(async (req, res) => { await st.putWeek(uid(req), req.body.week); ok(res) }))
  r.put('/plan/days/:d', h(async (req, res) => { await st.putDay(uid(req), req.params.d, req.body.value); ok(res) }))
  r.delete('/plan/days/:d', h(async (req, res) => { await st.delDay(uid(req), req.params.d); ok(res) }))

  /* exercises */
  r.put('/exercise-weights/:id', h(async (req, res) => { await st.putExWeight(uid(req), req.params.id, req.body); ok(res) }))
  r.delete('/exercise-weights/:id', h(async (req, res) => { await st.delExWeight(uid(req), req.params.id); ok(res) }))
  r.put('/custom-exercises/:id', h(async (req, res) => { await st.putCustomEx(uid(req), req.params.id, req.body); ok(res) }))
  r.delete('/custom-exercises/:id', h(async (req, res) => { await st.delCustomEx(uid(req), req.params.id); ok(res) }))

  /* finished workouts (history): edit — e.g. the session rating and note — or delete */
  r.get('/workouts', h(async (req, res) => res.json({ workouts: await st.loadWorkouts(uid(req)) })))
  r.put('/workouts/:id', h(async (req, res) => {
    if (req.body.id !== req.params.id) throw bad('workout id mismatch')
    await st.putWorkout(uid(req), req.body); ok(res)
  }))
  r.delete('/workouts/:id', h(async (req, res) => { await st.delWorkout(uid(req), req.params.id); ok(res) }))

  /* food */
  r.put('/food/log/:id', h(async (req, res) => { await st.putFoodEntry(uid(req), req.params.id, req.body); ok(res) }))
  r.delete('/food/log/:id', h(async (req, res) => { await st.delFoodEntry(uid(req), req.params.id); ok(res) }))
  r.put('/food/custom/:id', h(async (req, res) => { await st.putCustomFood(uid(req), req.params.id, req.body); ok(res) }))
  r.delete('/food/custom/:id', h(async (req, res) => { await st.delCustomFood(uid(req), req.params.id); ok(res) }))

  return r
}
