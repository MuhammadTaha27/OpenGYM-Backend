import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dayTotals, recentFoods, suggestGoals, searchMine, entryNutrients, hasMicros } from '../../src/logic/nutrition.js'
import { searchFoods, matchItem, scale, sumNutrients, tokens, foodById } from '../../src/logic/food-search.js'

const db = JSON.parse(readFileSync(new URL('../../src/data/foods.json', import.meta.url), 'utf8'))
const entry = (o) => ({ id: Math.random().toString(36).slice(2), t: Date.now(), ...o })

describe('the food table', () => {
  it('every row has energy and the three macros', () => {
    for (const [, , vals] of db.foods) for (const i of [0, 1, 2, 3]) expect(vals[i]).not.toBeNull()
  })
})

describe('search', () => {
  const top = q => searchFoods(db, q, 1)[0]?.food.name
  it('finds foods by the words people use', () => {
    expect(top('beef kebab')).toMatch(/beef shish kabob/i)
    expect(top('naan')).toBe('Bread, naan')
    expect(top('biryani chicken')).toBe('Biryani with chicken')
    expect(top('2% milk')).toMatch(/milk.*2%/i)
    expect(top('banana')).toMatch(/^Bananas?, raw$/)
  })
  it('a count in the query is not part of the food', () => {
    expect(top('2 eggs scrambled')).toMatch(/scrambled egg/i)
  })
  it('nothing for nothing', () => {
    expect(searchFoods(db, '', 5)).toEqual([])
    expect(searchFoods(db, 'qwxzv', 5)).toEqual([])
  })
  it('tokens singularise and map spellings onto USDA wording', () => {
    expect(tokens('Kebabs with yoghurt')).toEqual(['kabob', 'yogurt'])
    expect(tokens('hummus')).toEqual(['hummus'])
  })
})

describe('matching an AI-identified item', () => {
  it('takes a good text match with plausible energy', () => {
    const { best } = matchItem(db, { queries: ['Rice, white, cooked'], kcal100: 130 })
    expect(best.name).toMatch(/^Rice, white, cooked/)
  })
  it('refuses a perfect text match whose energy is far off the estimate', () => {
    const { best } = matchItem(db, { queries: ['Olive oil'], kcal100: 100 })
    expect(best?.name).not.toBe('Olive oil')
  })
  it('refuses a match that covers only part of the description', () => {
    expect(matchItem(db, { queries: ['Zorblax stew'], kcal100: 100 }).best).toBeNull()
  })
})

describe('nutrient math', () => {
  it('scales per-100 g values linearly and keeps missing values missing', () => {
    expect(scale({ kcal: 200, p: 10 }, 50)).toEqual({ kcal: 100, p: 5 })
    expect(sumNutrients([{ kcal: 100 }, { kcal: 50, vC: 3 }])).toEqual({ kcal: 150, vC: 3 })
  })
  it('a logged USDA food carries micronutrients through to the day totals', () => {
    const f = foodById(db, searchFoods(db, 'spinach raw', 1)[0].food.id)
    const S = { food: { log: [
      entry({ d: '2026-10-13', meal: 'lunch', name: 'Spinach', g: 200, src: 'usda', fid: f.id, food: f.name, per100: f.per100 }),
      entry({ d: '2026-10-13', meal: 'lunch', name: 'Bar', g: 50, src: 'custom', per100: { kcal: 400, p: 40 } }),
      entry({ d: '2026-10-12', meal: 'dinner', name: 'Yesterday', g: 100, src: 'custom', per100: { kcal: 999 } })
    ] } }
    const { n, count, partial } = dayTotals(S, '2026-10-13')
    expect(count).toBe(2)
    expect(partial).toBe(1)
    expect(n.kcal).toBeCloseTo(f.per100.kcal * 2 + 200, 0)
    expect(n.vK).toBeGreaterThan(0)
    expect(entryNutrients(S.food.log[1])).toEqual({ kcal: 200, p: 20 })
  })
  it('a custom food with micros does not make the day partial', () => {
    const e = entry({ d: '2026-10-13', name: 'Tikka', g: 150, src: 'custom', per100: { kcal: 150, p: 25, fe: 1.2 } })
    expect(dayTotals({ food: { log: [e] } }, '2026-10-13').partial).toBe(0)
  })
  it('only rows without vitamins and minerals make the micro totals partial', () => {
    expect(hasMicros({ kcal: 100, p: 5, fib: 2, na: 100 })).toBe(false)
    expect(hasMicros({ kcal: 100, ca: 20 })).toBe(true)
  })
})

describe('helpers', () => {
  it('recent foods are newest first and unique', () => {
    const log = ['a', 'b', 'a', 'c'].map((name, i) => ({ id: String(i), d: '2026-10-13', t: i, name, g: 100, per100: {}, fid: null }))
    expect(recentFoods({ food: { log } }).map(e => e.name)).toEqual(['c', 'a', 'b'])
    expect(recentFoods({})).toEqual([])
  })
  it('recent foods go by when they were eaten, not by row order', () => {
    const log = [
      { id: '1', d: '2026-10-14', t: 1, name: 'later', per100: {} },
      { id: '2', d: '2026-10-13', t: 2, name: 'earlier', per100: {} }
    ]
    expect(recentFoods({ food: { log } }).map(e => e.name)).toEqual(['later', 'earlier'])
  })
  it('suggested goals follow body weight, unit and goal direction', () => {
    expect(suggestGoals({ bodyweight: [] })).toBeNull()
    const kg = suggestGoals({ unit: 'kg', bodyweight: [{ w: 80 }], targetW: null })
    expect(kg).toEqual({ kcal: 2640, p: 144, f: 64, c: 372 })
    const lb = suggestGoals({ unit: 'lb', bodyweight: [{ w: 176.37 }], targetW: null })
    expect(lb.p).toBe(144)
    expect(suggestGoals({ unit: 'kg', bodyweight: [{ w: 80 }], targetW: 70 }).kcal).toBeLessThan(kg.kcal)
    expect(suggestGoals({ unit: 'kg', bodyweight: [{ w: 80 }], targetW: 90 }).kcal).toBeGreaterThan(kg.kcal)
  })
  it('my-foods search matches the start of any word, in any order', () => {
    const list = [{ name: 'Chicken tikka' }, { name: 'Protein bar (choc)' }, { name: 'Tikka masala sauce' }]
    expect(searchMine(list, 'tik').map(c => c.name)).toEqual(['Chicken tikka', 'Tikka masala sauce'])
    expect(searchMine(list, 'tikka chick').map(c => c.name)).toEqual(['Chicken tikka'])
    expect(searchMine(list, 'choc').map(c => c.name)).toEqual(['Protein bar (choc)'])
    expect(searchMine(list, '')).toBe(list)
  })
})
