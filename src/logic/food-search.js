// Food search + nutrient math over the USDA table in src/data/foods.json.
//
// Server-side: GET /api/food/search runs manual search through it, and the meal AI uses it to
// match what the model identified to real foods. Kept dependency-free.
//
// The split mirrors the Coach's: the AI is trusted with judgement (what is on the plate, how
// much of it), never with the numbers. Nutrients come from USDA rows and are scaled here.

// Spellings the USDA descriptions don't use, mapped onto ones they do. Kept short on purpose —
// the AI is told to search with USDA wording; this catches what people type by hand.
const SYN = {
  kebab: 'kabob', kebabs: 'kabob', kabab: 'kabob', kabobs: 'kabob',
  yoghurt: 'yogurt', yoghurts: 'yogurt', curd: 'yogurt',
  chickpea: 'chickpeas', garbanzo: 'chickpeas', aubergine: 'eggplant', courgette: 'zucchini',
  prawn: 'shrimp', prawns: 'shrimp', mince: 'ground', minced: 'ground', porridge: 'oatmeal',
  chips: 'fries', crisps: 'chips', biscuit: 'cookie', biscuits: 'cookies', capsicum: 'peppers',
  coriander: 'cilantro', rocket: 'arugula', scallion: 'onions', 'spring onion': 'onions',
  roti: 'chapati', chapatti: 'chapati', dal: 'lentils', daal: 'lentils', dhal: 'lentils',
  bbq: 'barbecue'
}
const STOP = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'or', 'in', 'on', 'g', 'gram', 'grams', 'some', 'my', 'piece', 'pieces', 'ns', 'as', 'to', 'nfs'])

// Lowercase, strip punctuation, crude singular — "Potatoes, mashed" and "mashed potato" share
// tokens. Stemming is deliberately dumb: anything smarter mangles food words (hummus, couscous).
export function tokens(s) {
  return String(s || '').toLowerCase()
    .replace(/%/g, ' pct ')
    .split(/[^a-z0-9À-ɏ]+/)
    .filter(w => w && !STOP.has(w))
    .map(w => SYN[w] || w)
    .map(w => (w.length > 3 && /[^s]s$/.test(w) && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w))
}

// The index is built once per table and cached on it — 13k rows tokenised in a few ms.
const IDX = new WeakMap()
function indexOf(db) {
  let idx = IDX.get(db)
  if (idx) return idx
  idx = db.foods.map(([id, name]) => {
    const head = tokens(name.split(',')[0])
    return { id, all: new Set(tokens(name)), head: new Set(head), len: name.length }
  })
  IDX.set(db, idx)
  return idx
}

/**
 * Scores every food against a free-text query. Returns [{ food, score, cover }] best first;
 * `cover` is the share of the query's words the food's description accounts for.
 */
export function searchFoods(db, query, limit = 25) {
  // A bare count ("2 eggs") is a quantity, not part of the food's name; "2% milk" keeps its 2.
  const q = [...new Set(tokens(query).filter((w, i, a) => !/^\d+$/.test(w) || a[i + 1] === 'pct'))]
  if (!q.length || !db?.foods?.length) return []
  const idx = indexOf(db)
  const out = []
  for (let i = 0; i < idx.length; i++) {
    const row = idx[i]
    let hit = 0, headHit = 0
    for (const w of q) {
      if (row.all.has(w)) { hit += 1; if (row.head.has(w)) headHit++ }
      else if (w.length >= 3) {
        // Prefix either way: "chick" finds chicken, "spaghetti" finds "spaghetti,".
        for (const t of row.all) if (t.startsWith(w) || (t.length >= 4 && w.startsWith(t))) { hit += 0.6; break }
      }
    }
    if (hit < Math.max(1, q.length * 0.5)) continue
    // Covering the whole query matters most; then the query naming the food's head noun
    // ("Chicken, …" for "chicken breast"), and the head naming nothing the query didn't — a
    // plain "banana" is "Bananas, raw", not "Banana split"; then fewer extra words overall.
    const extra = row.all.size - hit
    const headMiss = row.head.size - headHit
    const score = (hit / q.length) * 10 + headHit * 2 - headMiss * 1.2 - extra * 0.15 - row.len / 250 +
      // Survey foods are described as eaten, which is what a logged meal is.
      (row.id[0] === 'f' ? 0.4 : 0)
    out.push({ i, score, cover: hit / q.length })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, limit).map(({ i, score, cover }) => ({ food: rowToFood(db, db.foods[i]), score, cover }))
}

/** A table row as an object: { id, name, per100: { kcal, p, … }, portions: [[label, g]] }. */
export function rowToFood(db, row) {
  const [id, name, vals, portions] = row
  const per100 = {}
  db.nutrients.forEach((n, i) => { if (vals[i] != null) per100[n.key] = vals[i] })
  return { id, name, per100, portions: portions || [] }
}

export function foodById(db, id) {
  const row = db.foods.find(r => r[0] === id)
  return row ? rowToFood(db, row) : null
}

/** Nutrients for `g` grams of something described per 100 g. Missing values stay missing. */
export function scale(per100, g) {
  const out = {}
  const k = (+g || 0) / 100
  for (const key in per100) if (per100[key] != null) out[key] = per100[key] * k
  return out
}

/** Sums nutrient objects. A key absent everywhere stays absent, rather than becoming 0. */
export function sumNutrients(list) {
  const out = {}
  for (const n of list) for (const key in n) if (n[key] != null) out[key] = (out[key] || 0) + n[key]
  return out
}

/**
 * Picks the USDA food for one AI-identified item, or decides none fits.
 *
 * The AI supplies USDA-style search phrases and its own per-100 g energy estimate. The estimate
 * is not used as a value — it is a sanity check: a candidate whose energy is wildly off the
 * estimate is a bad text match ("Chicken, broilers, giblets" for "chicken"), and gets skipped.
 * When nothing survives, the caller falls back to the AI's estimate and labels it as such.
 */
export function matchItem(db, { queries, kcal100 }) {
  const seen = new Map()
  for (const q of (queries || []).slice(0, 3)) {
    searchFoods(db, q, 8).forEach(({ food, score, cover }, rank) => {
      // Earlier queries are the AI's best guess; a hit on them outranks the same score later.
      const s = score - rank * 0.05
      const prev = seen.get(food.id)
      if (!prev || prev.score < s) seen.set(food.id, { food, score: s, cover })
    })
  }
  const ranked = [...seen.values()].sort((a, b) => b.score - a.score)
  const plausible = c => !(kcal100 > 0) || (c.food.per100.kcal >= kcal100 * 0.6 - 25 && c.food.per100.kcal <= kcal100 * 1.4 + 25)
  // A weak text match is worse than an honest estimate: the description has to account for
  // (nearly) every word of a query — "Stew, beef" is not a "Zorblax stew".
  const best = ranked.find(c => c.cover >= 0.8 && c.score >= 8 && plausible(c)) || null
  return { best: best?.food || null, alternatives: ranked.slice(0, 6).map(c => c.food) }
}
