-- openGym schema. Every log a person keeps is a row of its own: each workout, each exercise in
-- it, each set, each weigh-in, each food eaten. Dates are 'YYYY-MM-DD' text in the user's own
-- calendar (never converted through a server timezone); instants are epoch milliseconds.
-- Fields the app may add later ride along in `extra` instead of being dropped.

CREATE TABLE users (
  id             text PRIMARY KEY,
  email          text NOT NULL UNIQUE,            -- stored lower-cased
  name           text NOT NULL,
  password_hash  text NOT NULL,
  is_admin       boolean NOT NULL DEFAULT false,
  disabled       boolean NOT NULL DEFAULT false,
  token_version  integer NOT NULL DEFAULT 0,      -- bump = sign out everywhere
  last_reminder  text,                            -- date the day reminder last fired
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

-- Preferences (unit, theme, rest timer, reminder, food goals, …): one document per user.
CREATE TABLE settings (
  user_id     text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bodyweight (
  user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  d        text NOT NULL,
  w        double precision NOT NULL,
  t        double precision,
  PRIMARY KEY (user_id, d)
);

CREATE TABLE routines (
  user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id       text NOT NULL,
  pos      integer NOT NULL DEFAULT 0,
  name     text NOT NULL,
  emoji    text,
  prog     text,
  ex       jsonb NOT NULL DEFAULT '[]'::jsonb,    -- planned exercises: sets/reps/weight/mode/superset
  extra    jsonb,
  PRIMARY KEY (user_id, id)
);

-- Weekly schedule: weekday (0 = Sunday) → routine.
CREATE TABLE week_plan (
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  routine_id  text NOT NULL,
  PRIMARY KEY (user_id, weekday)
);

-- One-off reschedules: a date → routine id, or 'rest'.
CREATE TABLE day_plan (
  user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  d        text NOT NULL,
  value    text NOT NULL,
  PRIMARY KEY (user_id, d)
);

-- Confirmed working weight per exercise — the default the next session starts from.
CREATE TABLE exercise_weights (
  user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ex_id    text NOT NULL,
  w        double precision NOT NULL,
  d        text,
  PRIMARY KEY (user_id, ex_id)
);

CREATE TABLE custom_exercises (
  user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id       text NOT NULL,
  data     jsonb NOT NULL,                        -- { n, bp, desc, tg, eq, custom }
  PRIMARY KEY (user_id, id)
);

CREATE TABLE workouts (
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id          text NOT NULL,
  d           text NOT NULL,
  start_ms    double precision,
  end_ms      double precision,
  routine_id  text,
  name        text NOT NULL DEFAULT '',
  bw          double precision,
  vol         double precision NOT NULL DEFAULT 0,
  prs         jsonb NOT NULL DEFAULT '[]'::jsonb,
  rating      text,
  note        text,
  extra       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
CREATE INDEX workouts_by_day ON workouts (user_id, d);

CREATE TABLE workout_entries (
  user_id     text NOT NULL,
  workout_id  text NOT NULL,
  pos         integer NOT NULL,
  ex_id       text NOT NULL,
  target      jsonb,                              -- what the session prescribed
  top_w       double precision,                   -- confirmed working weight
  extra       jsonb,
  PRIMARY KEY (user_id, workout_id, pos),
  FOREIGN KEY (user_id, workout_id) REFERENCES workouts(user_id, id) ON DELETE CASCADE
);
CREATE INDEX workout_entries_by_ex ON workout_entries (user_id, ex_id);

CREATE TABLE workout_sets (
  user_id     text NOT NULL,
  workout_id  text NOT NULL,
  entry_pos   integer NOT NULL,
  pos         integer NOT NULL,
  done        boolean NOT NULL DEFAULT false,
  w           double precision,
  r           double precision,
  sec         double precision,
  min         double precision,
  speed       double precision,
  rir         double precision,
  rpe         double precision,
  extra       jsonb,
  PRIMARY KEY (user_id, workout_id, entry_pos, pos),
  FOREIGN KEY (user_id, workout_id, entry_pos) REFERENCES workout_entries(user_id, workout_id, pos) ON DELETE CASCADE
);

-- The session in progress, saved as it goes so a closed app (or a second device) resumes it.
CREATE TABLE active_workouts (
  user_id     text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE food_log (
  user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id       text NOT NULL,
  d        text NOT NULL,
  t        double precision,
  meal     text NOT NULL,
  name     text NOT NULL,
  g        double precision NOT NULL,
  src      text,
  fid      text,
  food     text,
  per100   jsonb NOT NULL DEFAULT '{}'::jsonb,
  via      text,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX food_log_by_day ON food_log (user_id, d);

CREATE TABLE custom_foods (
  user_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id        text NOT NULL,
  name      text NOT NULL,
  serving   double precision NOT NULL,
  per100    jsonb NOT NULL DEFAULT '{}'::jsonb,
  from_ref  jsonb,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE push_subscriptions (
  endpoint    text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keys        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- AI meal analysis calls per user per day (the free Gemini tier has a quota).
CREATE TABLE ai_usage (
  user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      text NOT NULL,
  n        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
