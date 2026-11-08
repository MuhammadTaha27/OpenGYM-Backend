// Food-log math over S.food (server copy of the computations in the app's lib/nutrition.js).
//   S.food = { log: [{ id, d, t, meal, name, g, src, fid, food, per100, via }], custom, goals, aiOk }
import { scale, sumNutrients } from './food-search.js'

export const entryNutrients = e => scale(e.per100 || {}, e.g)

// Vitamins and minerals — the values only a full analysis carries. A row without any of them
// (an AI estimate, a quick add from a label) makes the day's micro totals a lower bound.
const MICRO_ONLY = ['k', 'ca', 'fe', 'mg', 'phos', 'zn', 'cu', 'se', 'vA', 'vC', 'vD', 'vE', 'vK', 'b1', 'b2', 'b3', 'b6', 'fol', 'b12', 'chl']
export const hasMicros = per100 => MICRO_ONLY.some(k => (per100 || {})[k] != null)

export const entriesOn = (S, d) => (S.food?.log || []).filter(e => e.d === d)

export function dayTotals(S, d) {
  const list = entriesOn(S, d)
  return {
    n: sumNutrients(list.map(entryNutrients)),
    count: list.length,
    partial: list.filter(e => !hasMicros(e.per100)).length
  }
}

/** Recently logged foods, newest first, one per food (USDA id, else name). */
export function recentFoods(S, limit = 12) {
  const seen = new Set(), out = []
  const log = [...(S.food?.log || [])].sort((a, b) => (a.d === b.d ? (a.t || 0) - (b.t || 0) : a.d < b.d ? -1 : 1))
  for (let i = log.length - 1; i >= 0 && out.length < limit; i--) {
    const e = log[i]
    const k = e.fid || e.name.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
  }
  return out
}

/** Name search over the user's own foods: every query word has to start a word of the name. */
export function searchMine(list, q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return list
  return list.filter(c => {
    const name = c.name.toLowerCase().split(/[^a-z0-9À-ɏЀ-ӿ]+/).filter(Boolean)
    return words.every(w => name.some(n => n.startsWith(w)) || c.name.toLowerCase().includes(w))
  })
}

const LB = 0.45359237

/**
 * A starting point from body weight, not a prescription: ~33 kcal/kg maintenance, protein at
 * 1.8 g/kg, fat at 0.8 g/kg, carbs the rest. Shifted ±15 % when a goal weight says the person
 * wants to lose or gain.
 */
export function suggestGoals(S) {
  const last = (S.bodyweight || [])[S.bodyweight.length - 1]
  if (!last) return null
  const kg = S.unit === 'lb' ? last.w * LB : last.w
  const goal = S.targetW != null ? (S.unit === 'lb' ? S.targetW * LB : S.targetW) : null
  const adj = goal == null || Math.abs(goal - kg) < 1 ? 1 : goal < kg ? 0.85 : 1.15
  const kcal = Math.round((kg * 33 * adj) / 10) * 10
  const p = Math.round(kg * 1.8)
  const f = Math.round(kg * 0.8)
  const c = Math.max(0, Math.round((kcal - p * 4 - f * 9) / 4))
  return { kcal, p, c, f }
}
