-- AirCast schema (PostgreSQL 16). Idempotent: safe to run on every boot.

CREATE TABLE IF NOT EXISTS cities (
  id        SERIAL PRIMARY KEY,
  name      TEXT NOT NULL,
  state     TEXT,
  lat       DOUBLE PRECISION NOT NULL,
  lng       DOUBLE PRECISION NOT NULL,
  UNIQUE (name, state)
);

CREATE TABLE IF NOT EXISTS stations (
  id         SERIAL PRIMARY KEY,
  city_id    INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL,          -- OpenAQ location id
  name       TEXT,
  lat        DOUBLE PRECISION,
  lng        DOUBLE PRECISION,
  UNIQUE (source_id)
);

CREATE TABLE IF NOT EXISTS readings (
  id          BIGSERIAL PRIMARY KEY,
  station_id  INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL,
  pm25        DOUBLE PRECISION,
  pm10        DOUBLE PRECISION,
  no2         DOUBLE PRECISION,
  o3          DOUBLE PRECISION,
  aqi         INTEGER,               -- computed AQI (US EPA, from PM2.5/PM10)
  UNIQUE (station_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_readings_station_ts ON readings (station_id, ts DESC);

CREATE TABLE IF NOT EXISTS subscriptions (
  id          SERIAL PRIMARY KEY,
  city_id     INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL DEFAULT 'web',   -- 'web' | 'email' | ...
  threshold   INTEGER NOT NULL DEFAULT 150,  -- alert when AQI >= threshold
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed your own city first so the app is never empty at judging.
INSERT INTO cities (name, state, lat, lng) VALUES
  ('Varanasi',  'Uttar Pradesh', 25.3176, 82.9739),
  ('Delhi',     'Delhi',         28.6139, 77.2090),
  ('Mumbai',    'Maharashtra',   19.0760, 72.8777),
  ('Kolkata',   'West Bengal',   22.5726, 88.3639)
ON CONFLICT (name, state) DO NOTHING;
