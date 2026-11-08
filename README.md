# openGym backend

The API the openGym app calls for everything: accounts, every record a user keeps, and the training and nutrition
logic. Node 22, Express, Postgres.

## Run it locally

```sh
npm install
npm run dev          # http://localhost:3000, settings from ../.env
npm test             # logic unit tests + HTTP tests against an in-memory Postgres (never touches DATABASE_URL)
```

`npm run dev` and `npm run migrate` load `../.env` (the app's repo root when this folder sits inside it). With
`DATABASE_URL` set it uses that Postgres; without it, an embedded Postgres in `./.pgdata`, so nothing needs
installing. Tables are created on boot. The frontend dev server (`cd ../frontend && npm run dev`)
proxies `/api` here.

## Layout

```
src/
  server.js        boot: connect, migrate, listen, reminder ticker
  app.js           Express app: CORS, logging, routes, errors
  db.js            pg pool (DATABASE_URL) or PGlite; migrations; transactions
  migrations/      schema, applied in order on boot
  auth.js          email + password, bcrypt, JWT sessions
  state.js         rows ⇄ the app's state object; every write sanitised here
  http.js          errors + input sanitisers
  routes/          records · workout · insights · data · push · admin
  logic/           progression, history, 1RM, effort, muscles, stats, nutrition, food search,
                   CSV/plan import — pure functions over the assembled state
  meals/           Gemini meal analysis
  data/            exercise library + USDA food table (npm run sync-data copies them from the app)
```

## Storage

Each log is its own row: `workouts` → `workout_entries` → `workout_sets`, `bodyweight`, `food_log`, `routines`,
`week_plan`, `day_plan`, `exercise_weights`, `custom_exercises`, `custom_foods`, plus `settings` (one preferences
document per user) and `active_workouts` (the session in progress, saved as it changes). Dates are the user's own
calendar dates as `YYYY-MM-DD`; instants are epoch milliseconds.

## API

All routes are under `/api`. Everything except health, config, signup and login needs
`Authorization: Bearer <token>`. The app sends `X-Timezone` (IANA zone) so "today" means the user's today.

| | |
|---|---|
| `GET /health`, `GET /config` | liveness; what the server offers (`signup`, `meals.ai`) |
| `POST /auth/signup` `{name,email,password}` · `POST /auth/login` `{email,password}` | → `{token, user}` |
| `GET /auth/me` · `PATCH /auth/me {name}` · `POST /auth/password {current,password}` · `POST /auth/logout-all` · `DELETE /auth/me {password}` | account |
| `GET /state` | everything the user has, in the app's state shape |
| `PATCH /settings` | preferences (unit, theme, rest timer, reminder, food goals, …) |
| `PUT/DELETE /bodyweight/:date` | one weigh-in per day |
| `PUT/DELETE /routines/:id` · `PUT /plan/week` · `PUT/DELETE /plan/days/:date` | the plan |
| `PUT/DELETE /exercise-weights/:exId` · `PUT/DELETE /custom-exercises/:id` | exercises |
| `GET /workouts` · `PUT/DELETE /workouts/:id` | history (edit = rating/note, delete) |
| `POST /workouts/active {routineId,bw}` | start: server builds sets + progression prescription |
| `POST /workouts/active/entries {cfg,active}` | add an exercise mid-session |
| `PUT/DELETE /workouts/active` | autosave / discard the session in progress |
| `POST /workouts/active/finish {active}` | log it: volume, PRs, 1RM records, next working weights, muscle load |
| `GET /summary` | streak, best weights, this week, today's food totals |
| `GET /stats` · `GET /stats/exercise/:id` | Stats screen: tiles, muscle balance, effort, progress curves |
| `PUT/DELETE /food/log/:id` · `PUT/DELETE /food/custom/:id` | food log, your own foods |
| `GET /food/search?q=` · `GET /food/day?d=` · `GET /food/recent` · `GET /food/suggest-goals` · `GET /food/usda/:id` | nutrition |
| `POST /meals/analyze {text,image}` | photo/description → foods (Gemini) |
| `POST /plan/starter` · `GET /plan/export` · `POST /plan/parse` · `POST /plan/import` | plans |
| `POST /import/parse {text}` · `POST /import/commit {text}` | history from FitNotes / Strong / Hevy / Apple Health |
| `GET /data/export` · `POST /data/import {state}` · `DELETE /data` | backup, restore, reset |
| `POST /push/subscribe` … · `POST /activity` | web push, live presence |
| `GET /admin/users` · `GET /admin/user?id=` · `POST /admin/user/disable` · `GET /admin/meals` | admin |

## Environment

| Variable | |
|---|---|
| `DATABASE_URL` | Postgres connection string (Neon: `postgresql://…?sslmode=require`). Required in production |
| `JWT_SECRET` | Signs sessions. Required in production (or `DATA_DIR`, where one is generated and kept) |
| `CORS_ORIGINS` | Web app origins allowed to call the API, comma-separated. The Android app (`https://localhost`) is always allowed |
| `ADMIN_EMAILS` | Accounts that get the admin dashboard |
| `SIGNUP_DISABLED=1` | Close sign-ups |
| `SESSION_DAYS` | Session length, default 90 |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `MEALS_DAILY_LIMIT` | AI meal analysis (optional; default limit 30/user/day) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web push (optional; `npm run vapid` makes a pair) |
| `PGLITE_DIR`, `DATA_DIR` | Embedded Postgres on a persistent volume instead of `DATABASE_URL` (Docker) |

## Deploy free on Render + Neon

1. Create a free project at [neon.com](https://neon.com) and copy its connection string.
2. On [render.com](https://render.com): **New → Blueprint**, pick this repository. `render.yaml` defines the service.
3. Fill in `DATABASE_URL`, `ADMIN_EMAILS`, and `CORS_ORIGINS` (your web app's URL, if you host one).
   `JWT_SECRET` is generated for you.
4. Check `https://<service>.onrender.com/api/health` → `{"ok":true}`, then point the app at that URL
   (`VITE_API_URL`) and create an account.

Free instances sleep after 15 minutes idle; the first request after that takes up to a minute.
`Dockerfile` is there for any container host (`docker build -t opengym-api .`).
