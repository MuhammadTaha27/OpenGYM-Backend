// `npm run migrate` — apply pending migrations and exit (the server also does this on boot).
import { connect, close } from './db.js'

await connect()
await close()
console.log('migrations up to date')
