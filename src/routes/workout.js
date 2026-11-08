// The training session, start to finish. The server builds each session — the sets, the
// weights the progression policy prescribes and why — and judges the finished one: volume,
// load PRs, best estimated 1RMs and the working weights the next session starts from.
import { Router } from 'express'
import { h, bad, HttpError, id, num, str } from '../http.js'
import { tx } from '../db.js'
import * as st from '../state.js'
import { buildSets } from '../logic/history.js'
import { nextPrescription, applyPrescription } from '../logic/progression.js'
import { loadOfWorkouts } from '../logic/muscles.js'
import { exerciseContext, recordsOf, workoutVolume } from '../logic/stats.js'
import { uid } from '../logic/format.js'

/** One session entry for a planned exercise, prescription applied. */
function buildEntry(S, cfg, routine) {
  const plan = nextPrescription(S, cfg, routine)
  return {
    id: cfg.id, ...(cfg.sg ? { sg: cfg.sg } : {}), target: { ...cfg }, plan,
    sets: applyPrescription(buildSets(S, cfg), plan),
    ...exerciseContext(S, cfg.id)
  }
}

// A planned exercise as the client describes it: only the fields the engine reads.
function cleanCfg(c) {
  if (!c || typeof c !== 'object') throw bad('exercise required')
  const out = { id: id(c.id, 'exercise id') }
  for (const k of ['sets', 'reps', 'repsMin', 'weight', 'sec', 'min', 'speed', 'inc']) {
    const v = num(c[k], { min: 0, max: 10000 })
    if (v != null) out[k] = v
  }
  for (const k of ['mode', 'prog', 'sg']) if (c[k]) out[k] = str(c[k], 40)
  return out
}

export function workoutRoutes() {
  const r = Router()
  const tz = req => req.headers['x-timezone']

  r.post('/workouts/active', h(async (req, res) => {
    const S = await st.loadState(req.user.id, { tz: tz(req) })
    const routineId = req.body.routineId ? id(req.body.routineId, 'routine id') : null
    const routine = routineId ? S.routines.find(x => x.id === routineId) : null
    if (routineId && !routine) throw new HttpError(404, 'no such routine')
    const active = {
      id: uid(), d: S.today, start: Date.now(), routineId,
      name: routine ? routine.name : str(req.body.name, 80) || 'Freestyle',
      bw: num(req.body.bw, { min: 0, max: 2000 }), cur: 0,
      entries: (routine ? routine.ex : []).map(cfg => buildEntry(S, cfg, routine))
    }
    await st.putActive(req.user.id, active)
    res.status(201).json({ active })
  }))

  // Add an exercise mid-session. `active` is the client's current copy (it may hold edits
  // still on their way); the server's copy is used when it isn't sent.
  r.post('/workouts/active/entries', h(async (req, res) => {
    const S = await st.loadState(req.user.id, { tz: tz(req) })
    const active = req.body.active || S.active
    if (!active || !Array.isArray(active.entries)) throw new HttpError(409, 'no workout in progress')
    const routine = S.routines.find(x => x.id === active.routineId)
    active.entries.push(buildEntry(S, cleanCfg(req.body.cfg), routine))
    active.cur = active.entries.length - 1
    await st.putActive(req.user.id, active)
    res.status(201).json({ active })
  }))

  r.put('/workouts/active', h(async (req, res) => { await st.putActive(req.user.id, req.body.active); res.json({ ok: true }) }))
  r.delete('/workouts/active', h(async (req, res) => { await st.delActive(req.user.id); res.json({ ok: true }) }))

  r.post('/workouts/active/finish', h(async (req, res) => {
    const S = await st.loadState(req.user.id, { tz: tz(req) })
    const A = req.body.active || S.active
    if (!A || !Array.isArray(A.entries)) throw new HttpError(409, 'no workout in progress')
    const { prs, e1prs } = recordsOf(S, A)
    const w = {
      id: id(A.id, 'workout id'), d: A.d || S.today, start: A.start, end: Date.now(), routineId: A.routineId || null,
      name: A.name, bw: A.bw ?? null,
      // `target` (what the session prescribed) stays with the sets — the progression engine
      // reads a session back against it.
      entries: A.entries
        .map(e => ({ id: e.id, sets: e.sets, topW: e.topW || null, target: e.target || null }))
        .filter(e => e.sets.some(s => s.done)),
      prs
    }
    w.vol = workoutVolume(w)
    const exWeights = {}
    w.entries.forEach(e => {
      const mx = Math.max(0, ...e.sets.filter(x => x.done).map(x => x.w || 0), e.topW || 0)
      const cur = S.exWeights[e.id]
      if (mx > 0 && (!cur || mx > cur.w)) exWeights[e.id] = { w: mx, d: w.d }
    })
    await tx(async t => {
      await st.putWorkout(req.user.id, w, t)
      for (const [ex, v] of Object.entries(exWeights)) await st.putExWeight(req.user.id, ex, v, t)
      await st.delActive(req.user.id, t)
    })
    res.json({ workout: w, prs, e1prs, exWeights, load: loadOfWorkouts([w]) })
  }))

  return r
}
