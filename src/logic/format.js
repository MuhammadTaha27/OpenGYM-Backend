// Date + id helpers shared by the logic modules (server copy of the app's lib/format.js —
// only the parts logic needs; display formatting stays in the app).

export const isoOf = d =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')

/** Today's date where the user is. The app sends its IANA zone with every request. */
export function todayISO(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date())
    const g = t => parts.find(p => p.type === t)?.value
    return `${g('year')}-${g('month')}-${g('day')}`
  } catch { return new Date().toISOString().slice(0, 10) }
}

export const DAYN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export const fmtNum = n => String(Math.round(n * 10) / 10)
export const exCount = n => (n === 1 ? '1 exercise' : n + ' exercises')

export function weekKey(d) {
  const dt = new Date(d + 'T12:00:00')
  const day = (dt.getDay() + 6) % 7
  dt.setDate(dt.getDate() - day + 3)
  const jan4 = new Date(dt.getFullYear(), 0, 4)
  const week = 1 + Math.round(((dt - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7)
  return dt.getFullYear() + '-' + week
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
