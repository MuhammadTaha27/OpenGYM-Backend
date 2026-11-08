// Copies the reference data the server computes against out of the frontend: the exercise
// library (body part, target muscles, equipment — progression, muscle maps and CSV import all
// read it) and the USDA food table (search + AI meal matching). Run after either changes:
//   npm run sync-data
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const OUT = path.resolve(HERE, '../src/data')
fs.mkdirSync(OUT, { recursive: true })

const { EXDB } = await import(pathToFileURL(path.join(ROOT, 'frontend/src/lib/exercises-data.js')))
// Instructions and media names stay in the app; the server only needs what logic reads.
const slim = EXDB.map(({ id, n, bp, eq, tg, mg, sm }) => ({ id, n, bp, eq, tg, mg, sm }))
fs.writeFileSync(path.join(OUT, 'exercises.json'), JSON.stringify(slim))
console.log(`exercises.json — ${slim.length} exercises`)

const foods = path.join(ROOT, 'api/meals/foods.json')
if (fs.existsSync(foods)) {
  fs.copyFileSync(foods, path.join(OUT, 'foods.json'))
  console.log('foods.json — copied')
}
