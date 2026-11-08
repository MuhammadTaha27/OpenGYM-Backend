// Whole-account operations: load everything, back up, restore, wipe — and the actions that
// merge a batch of records in at once (starter plan, a shared plan file, another app's export).
import { Router } from 'express'
import { h, bad } from '../http.js'
import { tx } from '../db.js'
import * as st from '../state.js'
import { starterRoutines } from '../logic/starter.js'
import { buildPlanBundle, parsePlan, mergePlan } from '../logic/plan-share.js'
import { parseImport, mergeImport } from '../logic/import-csv.js'

const clone = o => JSON.parse(JSON.stringify(o))

export function dataRoutes() {
  const r = Router()
  const load = req => st.loadState(req.user.id, { tz: req.headers['x-timezone'] })

  // Run the app's merge logic over a copy of the state, store what changed, return the result.
  async function change(req, fn) {
    const before = await load(req)
    const after = clone(before)
    const result = fn(after)
    await st.saveChanges(req.user.id, before, after)
    return { state: await load(req), result }
  }

  r.get('/state', h(async (req, res) => res.json({ state: await load(req) })))

  r.get('/data/export', h(async (req, res) => {
    const S = await load(req)
    res.setHeader('Content-Disposition', `attachment; filename="opengym-backup-${S.today}.json"`)
    res.json(S)
  }))

  r.post('/data/import', h(async (req, res) => {
    const data = req.body.state
    if (!data || !Array.isArray(data.workouts) || !Array.isArray(data.routines)) throw bad('not an openGym backup')
    await st.replaceAll(req.user.id, data)
    res.json({ state: await load(req) })
  }))

  r.delete('/data', h(async (req, res) => {
    await tx(t => st.wipe(req.user.id, t))
    res.json({ state: await load(req) })
  }))

  /* ---------- plan ---------- */

  r.post('/plan/starter', h(async (req, res) => {
    res.json(await change(req, s => {
      const [push, pull, legs] = starterRoutines()
      s.routines.push(push, pull, legs)
      s.week[1] = push.id; s.week[3] = pull.id; s.week[5] = legs.id
    }))
  }))

  r.get('/plan/export', h(async (req, res) => res.json(buildPlanBundle(await load(req), String(req.query.name || '').slice(0, 80)))))

  // Validate a shared plan file and say what it holds, before anything is written.
  r.post('/plan/parse', h(async (req, res) => {
    try { res.json(parsePlan(req.body.bundle)) } catch (e) { throw bad(e.message) }
  }))

  r.post('/plan/import', h(async (req, res) => {
    let bundle
    try { bundle = parsePlan(req.body.bundle) } catch (e) { throw bad(e.message) }
    res.json(await change(req, s => mergePlan(s, bundle, { schedule: !!req.body.schedule })))
  }))

  /* ---------- history from another app (FitNotes, Strong, Hevy, Apple Health) ---------- */

  const parse = async req => {
    const text = String(req.body.text || '')
    if (!text) throw bad('file is empty')
    if (text.length > 15 * 1024 * 1024) throw bad('file too large')
    const S = await load(req)
    const parsed = parseImport(text, { unit: S.unit === 'lb' ? 'lb' : 'kg' })
    if (parsed.error) throw bad(parsed.error)
    return { S, parsed }
  }

  r.post('/import/parse', h(async (req, res) => {
    const { S, parsed } = await parse(req)
    const isBW = parsed.kind === 'bodyweight'
    const have = isBW
      ? parsed.bodyweight.filter(b => S.bodyweight.some(x => x.d === b.d)).length
      : parsed.workouts.filter(w => S.workouts.some(x => x.d === w.d)).length
    res.json({ ...parsed, have, fresh: (isBW ? parsed.bodyweight.length : parsed.workouts.length) - have })
  }))

  r.post('/import/commit', h(async (req, res) => {
    const { parsed } = await parse(req)
    res.json(await change(req, s => mergeImport(s, parsed)))
  }))

  return r
}
