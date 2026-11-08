// Read-only, computed views: Home's summary, the Stats screen, one exercise's progress, a
// day of food, food search and the meal AI.
import { Router } from 'express'
import { h, bad, HttpError, id, isoDate, str } from '../http.js'
import { q, one } from '../db.js'
import { loadState } from '../state.js'
import { summary, stats, exerciseStats } from '../logic/stats.js'
import { dayTotals, recentFoods, suggestGoals, searchMine } from '../logic/nutrition.js'
import { searchFoods, foodById } from '../logic/food-search.js'
import { foodDb, analyze, parseImage } from '../meals/analyze.js'
import { GeminiError } from '../meals/gemini.js'
import { DEFAULT_MODEL } from '../meals/meal-ai.js'
import { todayISO } from '../logic/format.js'

export const mealsConfig = () => ({
  key: process.env.GEMINI_API_KEY || '',
  model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
  perUserDaily: Math.max(0, +(process.env.MEALS_DAILY_LIMIT || 30) || 0),
  on: !!process.env.GEMINI_API_KEY && !/^(1|true|yes|on)$/i.test(process.env.MEALS_AI_DISABLED || '')
})

// What a user sees when analysis fails. Provider detail goes to the server log.
const USER_ERROR = {
  quota: 'the free AI quota is used up for now — try again later, or add the food by search',
  timeout: 'the AI took too long — try again',
  blocked: "the AI couldn't look at that — try a description instead",
  default: "couldn't analyse that right now — add the food by search instead"
}

export function insightRoutes() {
  const r = Router()
  const load = req => loadState(req.user.id, { tz: req.headers['x-timezone'] })

  r.get('/summary', h(async (req, res) => res.json(summary(await load(req)))))
  r.get('/stats', h(async (req, res) => res.json(stats(await load(req)))))
  r.get('/stats/exercise/:id', h(async (req, res) => res.json(exerciseStats(await load(req), id(req.params.id)))))

  r.get('/food/day', h(async (req, res) => {
    const S = await load(req)
    res.json(dayTotals(S, req.query.d ? isoDate(req.query.d) : S.today))
  }))
  r.get('/food/recent', h(async (req, res) => res.json({ recent: recentFoods(await load(req)) })))
  r.get('/food/suggest-goals', h(async (req, res) => res.json({ goals: suggestGoals(await load(req)) })))

  // USDA table + the user's own foods. Empty query → nothing from USDA (it has 8 000 rows).
  r.get('/food/search', h(async (req, res) => {
    const qs = str(req.query.q, 100) || ''
    const limit = Math.max(1, Math.min(60, +req.query.limit || 40))
    const mine = (await q('SELECT id, name, serving, per100, from_ref FROM custom_foods WHERE user_id = $1 ORDER BY name', [req.user.id]))
      .map(c => ({ id: c.id, name: c.name, serving: c.serving, per100: c.per100 || {}, from: c.from_ref }))
    res.json({
      foods: qs.trim() ? searchFoods(foodDb(), qs, limit).map(x => x.food) : [],
      mine: searchMine(mine, qs)
    })
  }))
  r.get('/food/usda/:fid', h(async (req, res) => {
    const f = foodById(foodDb(), String(req.params.fid))
    if (!f) throw new HttpError(404, 'no such food')
    res.json({ food: f })
  }))

  r.post('/meals/analyze', h(async (req, res) => {
    const c = mealsConfig()
    if (!c.on) throw new HttpError(503, 'AI meal analysis is not set up on this server')
    const text = String(req.body.text || '').trim().slice(0, 600)
    const image = req.body.image ? parseImage(req.body.image) : null
    if (!text && !image) throw bad('describe the meal or add a photo')
    // Counted before the call: a failed call still spent quota.
    const day = todayISO()
    const used = await one(
      `INSERT INTO ai_usage (user_id, day, n) VALUES ($1, $2, 1)
       ON CONFLICT (user_id, day) DO UPDATE SET n = ai_usage.n + 1 RETURNING n`, [req.user.id, day])
    if (c.perUserDaily && used.n > c.perUserDaily) {
      throw new HttpError(429, 'daily AI limit reached — add the food by search, or try again tomorrow')
    }
    try {
      res.json(await analyze({ key: c.key, model: c.model, text, image }))
    } catch (e) {
      const code = e instanceof GeminiError ? e.code : 'internal'
      console.error('meals analyze', code, e.message)
      res.status(code === 'quota' ? 429 : 502).json({ error: USER_ERROR[code] || USER_ERROR.default, code })
    }
  }))

  return r
}
