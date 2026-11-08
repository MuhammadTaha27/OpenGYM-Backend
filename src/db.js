// Postgres access. Production (Render + Neon) sets DATABASE_URL and gets a `pg` pool. Without
// it the server runs an embedded Postgres (PGlite) in ./.pgdata — local development needs no
// database install, and the tests run against `memory://` the same way.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

let pool = null      // pg.Pool
let lite = null      // PGlite

export async function connect({ url = process.env.DATABASE_URL, liteDir = process.env.PGLITE_DIR || '.pgdata' } = {}) {
  // A hosted server without DATABASE_URL would quietly keep everyone's data on a disk that
  // free hosts wipe on every restart. In production the embedded database has to be asked
  // for by name (PGLITE_DIR on a persistent volume — the Docker setup does this).
  if (!url && process.env.NODE_ENV === 'production' && !process.env.PGLITE_DIR) {
    throw new Error('DATABASE_URL is not set. Point it at your Postgres (e.g. Neon), or set PGLITE_DIR to a persistent directory.')
  }
  if (url) {
    const pg = (await import('pg')).default
    // COUNT(*) and the like come back as int8; nothing here gets near 2^53.
    pg.types.setTypeParser(20, v => parseInt(v, 10))
    const local = /localhost|127\.0\.0\.1/.test(url)
    pool = new pg.Pool({
      connectionString: url,
      // Neon (and most hosted Postgres) require TLS; a local server usually has none.
      ssl: local || /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false },
      max: +(process.env.DB_POOL_MAX || 5),
      idleTimeoutMillis: 30000
    })
  } else {
    const { PGlite } = await import('@electric-sql/pglite')
    lite = new PGlite(liteDir)
    await lite.waitReady
  }
  await migrate()
}

export async function close() {
  if (pool) await pool.end()
  if (lite) await lite.close()
  pool = lite = null
}

/** One statement with $1-style params → rows. */
export async function q(sql, params = []) {
  const r = await (pool || lite).query(sql, params)
  return r.rows
}
export const one = async (sql, params) => (await q(sql, params))[0] || null

/**
 * Run fn inside a transaction. fn gets a `{ q, one }` bound to the transaction — use it for
 * every statement that must commit or roll back together.
 */
export async function tx(fn) {
  if (lite) {
    return lite.transaction(async t => {
      const tq = async (sql, params = []) => (await t.query(sql, params)).rows
      return fn({ q: tq, one: async (sql, params) => (await tq(sql, params))[0] || null })
    })
  }
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    const tq = async (sql, params = []) => (await c.query(sql, params)).rows
    const out = await fn({ q: tq, one: async (sql, params) => (await tq(sql, params))[0] || null })
    await c.query('COMMIT')
    return out
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally { c.release() }
}

/** Applies migrations/NNN_*.sql in order, each once, each in its own transaction. */
async function migrate() {
  const db = pool || lite
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
  const done = new Set((await db.query('SELECT version FROM schema_migrations')).rows.map(r => r.version))
  const dir = path.join(HERE, 'migrations')
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue
    const sql = fs.readFileSync(path.join(dir, f), 'utf8')
    if (lite) {
      await lite.transaction(async t => { await t.exec(sql); await t.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]) })
    } else {
      const c = await pool.connect()
      try {
        await c.query('BEGIN'); await c.query(sql)
        await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f])
        await c.query('COMMIT')
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
    }
    console.log('migrated', f)
  }
}
