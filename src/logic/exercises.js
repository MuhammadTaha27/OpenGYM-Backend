// The exercise library, server side. Built-ins come from data/exercises.json (npm run
// sync-data). A user's custom exercises live in their own rows, so EXIDX resolves them
// through a per-request store: the logic modules keep writing `EXIDX[id]` exactly as they
// did in the app, and two users' requests can never see each other's customs.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const EXDB = JSON.parse(fs.readFileSync(path.join(HERE, '../data/exercises.json'), 'utf8'))
const BASE = {}
EXDB.forEach(e => { BASE[e.id] = e })

const store = new AsyncLocalStorage()
/** Express middleware: every request gets its own (empty) custom-exercise scope. */
export const exerciseScope = (req, res, next) => store.run(new Map(), next)
/** Make one user's custom exercises resolvable for the rest of this request. */
export function useCustom(list) {
  const m = store.getStore()
  if (!m) return
  m.clear()
  ;(list || []).forEach(e => { if (e && e.id) m.set(e.id, e) })
}

export const EXIDX = new Proxy(BASE, {
  get(target, key) {
    const m = store.getStore()
    return (m && typeof key === 'string' && m.get(key)) || target[key]
  },
  has(target, key) {
    const m = store.getStore()
    return !!(m && m.has(key)) || key in target
  }
})

export const isCardio = idOrEx => (typeof idOrEx === 'string' ? EXIDX[idOrEx] : idOrEx)?.bp === 'cardio'
