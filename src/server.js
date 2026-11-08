import { connect } from './db.js'
import { createApp } from './app.js'
import { reminderTick } from './routes/push.js'

const PORT = +(process.env.PORT || 3000)

await connect()
createApp().listen(PORT, () => console.log(`opengym-backend on :${PORT} (${process.env.DATABASE_URL ? 'postgres' : 'embedded pglite'})`))

// Workout-day reminders: checked every 30 s.
setInterval(() => { reminderTick().catch(e => console.error('reminder tick', e)) }, 30000).unref()
