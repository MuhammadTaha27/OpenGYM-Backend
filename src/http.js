// Request-level helpers shared by every route module.

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
export const bad = msg => new HttpError(400, msg)

// Wraps an async handler so a thrown HttpError becomes its status, anything else a 500.
export const h = fn => async (req, res, next) => {
  try { await fn(req, res, next) } catch (e) { next(e) }
}

/* ---------------- input sanitizers ---------------- */
// Every value a client sends is bounded and typed here before it reaches SQL or a jsonb
// column — the app is not the only thing that can call this API.

const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/
export function id(v, what = 'id') {
  const s = String(v ?? '')
  if (!ID_RE.test(s)) throw bad(`invalid ${what}`)
  return s
}
export function isoDate(v, what = 'date') {
  const s = String(v ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(`invalid ${what}`)
  return s
}
// The default range has room for epoch-millisecond timestamps (~1.7e12); quantities that
// have a real ceiling pass their own.
export function num(v, { min = -1e15, max = 1e15 } = {}) {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, n))
}
export const str = (v, max = 200) => (v == null ? null : String(v).slice(0, max))
/** A JSON-able value capped at maxBytes once serialised. */
export function json(v, maxBytes = 64 * 1024, what = 'payload') {
  if (v === undefined) return null
  const s = JSON.stringify(v)
  if (s && s.length > maxBytes) throw bad(`${what} too large`)
  return v
}
