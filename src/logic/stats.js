// Everything the Stats and Home screens show that is computed rather than listed. Each
// function takes the assembled state S and returns plain data the app draws.
import { EXIDX } from './exercises.js'
import { weekKey } from './format.js'
import { lastEntryFor, bestWeightFor, streakWeeks, modeOf, effortOf, workoutVolume, setsDone } from './history.js'
import { e1rmSeries, best1RM, is1RMRecord } from './onerm.js'
import {
  hasEffort, displayScale, toScale, avgRir, effortSummary, effortWeeks, effortHistogram, isHardSet
} from './effort.js'
import { loadOfWorkouts, rankOf } from './muscles.js'
import { dayTotals } from './nutrition.js'

const DAY = 86400000
const tOf = b => b.t || new Date(b.d).getTime()

/** Small, always-fresh numbers for Home, the Library and the workout screen. */
export function summary(S) {
  const best = {}
  S.workouts.forEach(w => w.entries.forEach(e => { if (!(e.id in best)) best[e.id] = bestWeightFor(S, e.id) }))
  const last = S.bodyweight[S.bodyweight.length - 1] || null
  const prev = S.bodyweight.length > 1 ? S.bodyweight[S.bodyweight.length - 2] : null
  return {
    today: S.today,
    streak: streakWeeks(S),
    workouts: S.workouts.length,
    thisWeek: S.workouts.filter(w => weekKey(w.d) === weekKey(S.today)).length,
    plannedPerWeek: Object.keys(S.week).filter(k => S.week[k]).length,
    bw: { last, delta: last && prev ? last.w - prev.w : null },
    best,
    food: dayTotals(S, S.today)
  }
}

function muscleWindow(S, win) {
  const now = Date.now()
  const inWin = S.workouts.filter(w =>
    win === 0 ? true
      : win === 7 ? weekKey(w.d) === weekKey(S.today)
        : (w.start || new Date(w.d).getTime()) > now - win * DAY)
  const rated = inWin.some(w => w.entries.some(e => e.sets.some(s => s.done && isHardSet(s))))
  const view = load => ({ load, ...rankOf(load) })
  return {
    workouts: inWin.length,
    rated,
    all: view(loadOfWorkouts(inWin)),
    hard: rated ? view(loadOfWorkouts(inWin, isHardSet)) : null
  }
}

/** The Stats screen, minus the per-exercise chart (see exerciseStats). */
export function stats(S) {
  const now = Date.now()
  const bw30 = S.bodyweight.filter(b => tOf(b) > now - 30 * DAY)
  const anyEffort = hasEffort(S)
  const kind = displayScale(S)
  const exercises = [...new Set(S.workouts.flatMap(w => w.entries.map(e => e.id)))]
    .filter(id => EXIDX[id])
    .sort((a, b) => (EXIDX[a].n < EXIDX[b].n ? -1 : 1))
    .map(id => ({ id, n: EXIDX[id].n }))
  return {
    tiles: {
      workouts: S.workouts.length,
      month: S.workouts.filter(w => w.d.slice(0, 7) === S.today.slice(0, 7)).length,
      streak: streakWeeks(S),
      bwDelta30: bw30.length > 1 ? bw30[bw30.length - 1].w - bw30[0].w : null
    },
    muscle: Object.fromEntries([7, 30, 90, 0].map(win => [win, muscleWindow(S, win)])),
    effort: anyEffort ? {
      kind,
      logging: effortOf(S),
      windows: Object.fromEntries([30, 90, 365, 0].map(win => [win, {
        sum: effortSummary(S, win),
        weeks: effortWeeks(S, win).map(w => ({ ...w, y: toScale(kind, w.rir) })),
        hist: effortHistogram(S, win)
      }]))
    } : null,
    exercises
  }
}

/** Progress curves for one exercise: top set / longest hold / top speed, est. 1RM, effort. */
export function exerciseStats(S, exId) {
  const kind = displayScale(S)
  let mode = modeOf({ id: exId })
  for (let i = S.workouts.length - 1; i >= 0; i--) {
    const en = S.workouts[i].entries.find(e => e.id === exId)
    if (en) { mode = modeOf({ ...(en.target || {}), id: exId }); break }
  }
  const cardio = mode === 'cardio', timed = mode === 'time'
  const metric = s => (cardio ? (s.speed || 0) : timed ? (s.sec || 0) : (s.w || 0))
  const points = []
  let best = 0
  S.workouts.forEach(w => {
    const en = w.entries.find(e => e.id === exId)
    if (!en) return
    const sets = en.sets.filter(s => s.done)
    const mx = Math.max(0, ...sets.map(metric), cardio || timed ? 0 : (en.topW || 0))
    if (mx <= 0) return
    const rir = avgRir(sets)
    points.push({ t: w.start, y: mx, d: w.d, sets, target: en.target, rir, eff: rir == null ? null : toScale(kind, rir) })
    if (mx > best) best = mx
  })
  return {
    id: exId,
    mode,
    unit: cardio ? 'km/h' : timed ? 's' : S.unit,
    points,
    best,
    // what the exercise sheet shows: the last session and the heaviest weight ever logged
    last: lastEntryFor(S, exId),
    bestWeight: bestWeightFor(S, exId),
    e1: { points: e1rmSeries(S, exId), best: best1RM(S, exId) },
    kind
  }
}

/** What the workout screen shows next to one exercise: last session and best weight. */
export const exerciseContext = (S, exId) => ({ last: lastEntryFor(S, exId), best: bestWeightFor(S, exId) })

/** Records a finished session set (load PRs + best estimated 1RMs), judged against history. */
export function recordsOf(S, A) {
  const prs = [], e1prs = []
  A.entries.forEach(e => {
    const mx = Math.max(0, ...e.sets.filter(s => s.done).map(s => s.w || 0))
    if (mx > 0 && mx > bestWeightFor(S, e.id)) prs.push(e.id)
    // A heavier estimate without a heavier top set is its own kind of progress — same weight
    // for more reps. Reported separately so it can't be read as a load PR.
    const rec = is1RMRecord(S, e.id, e)
    if (rec && !prs.includes(e.id)) e1prs.push({ id: e.id, ...rec })
  })
  return { prs, e1prs }
}

export { workoutVolume, setsDone }
