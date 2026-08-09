/**
 * AirCast API — apps/api/src/index.ts
 * Hono + Postgres + Valkey. Serves the dashboard. No auth (public, read-mostly).
 *
 * Routes:
 *   GET  /health
 *   GET  /cities
 *   GET  /cities/:id/current           latest snapshot (cache-first)
 *   GET  /cities/:id/history?range=24h|7d
 *   GET  /cities/:id/forecast          naive projection + "safe windows"
 *   POST /cities/:id/subscribe         { threshold }
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import pkg from "pg";
import Redis from "ioredis";

const { Pool } = pkg;
// Prefer a full DATABASE_URL (set in zerops.yaml). If it's missing or Postgres
// exposed different var names, fall back to assembling from parts.
function dbConfig() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  const e = process.env;
  return {
    host: e.db_hostname || e.DB_HOST || "db",
    port: Number(e.db_port || e.DB_PORT || 5432),
    user: e.db_user || e.DB_USER || "db",
    password: e.db_password || e.DB_PASS || "",
    database: e.db_dbName || e.db_dbname || e.DB_NAME || "db",
  };
}
const pool = new Pool(dbConfig());
const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null })
  : new Redis({
      host: process.env.REDIS_HOST || "cache",
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null,
    });

// --- schema (idempotent) applied on boot; keep in sync with db/schema.sql ---
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cities (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, state TEXT,
  lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL,
  UNIQUE (name, state)
);
CREATE TABLE IF NOT EXISTS stations (
  id SERIAL PRIMARY KEY,
  city_id INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL, name TEXT,
  lat DOUBLE PRECISION, lng DOUBLE PRECISION, UNIQUE (source_id)
);
CREATE TABLE IF NOT EXISTS readings (
  id BIGSERIAL PRIMARY KEY,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL,
  pm25 DOUBLE PRECISION, pm10 DOUBLE PRECISION,
  no2 DOUBLE PRECISION, o3 DOUBLE PRECISION, aqi INTEGER,
  UNIQUE (station_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_readings_station_ts ON readings (station_id, ts DESC);
CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  city_id INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'web',
  threshold INTEGER NOT NULL DEFAULT 150,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO cities (name, state, lat, lng) VALUES
  ('Varanasi','Uttar Pradesh',25.3176,82.9739),
  ('Delhi','Delhi',28.6139,77.2090),
  ('Mumbai','Maharashtra',19.0760,72.8777),
  ('Kolkata','West Bengal',22.5726,88.3639)
ON CONFLICT (name, state) DO NOTHING;
`;

async function migrate() {
  await pool.query(SCHEMA);
  console.log("[api] schema ready");
}

function category(aqi: number): string {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for sensitive groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very unhealthy";
  return "Hazardous";
}

const app = new Hono();
app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true }));

app.get("/cities", async (c) => {
  const { rows } = await pool.query(
    `SELECT id, name, state, lat, lng FROM cities ORDER BY id`
  );
  return c.json(rows);
});

// latest snapshot: cache first, DB fallback
app.get("/cities/:id/current", async (c) => {
  const id = Number(c.req.param("id"));
  try {
    const cached = await redis.get(`city:${id}:latest`);
    if (cached) {
      const snap = JSON.parse(cached);
      return c.json({ ...snap, category: category(snap.aqi), source: "cache" });
    }
  } catch {}
  const { rows } = await pool.query(
    `SELECT r.aqi, r.pm25, r.pm10, r.no2, r.o3, r.ts, c.name
       FROM readings r
       JOIN stations s ON s.id = r.station_id
       JOIN cities c ON c.id = s.city_id
      WHERE c.id = $1 AND r.aqi IS NOT NULL
      ORDER BY r.ts DESC LIMIT 1`,
    [id]
  );
  if (!rows.length) return c.json({ error: "no data yet for this city" }, 404);
  const r = rows[0];
  return c.json({
    cityId: id, name: r.name, aqi: r.aqi, category: category(r.aqi),
    pm25: r.pm25, pm10: r.pm10, no2: r.no2, o3: r.o3, ts: r.ts, source: "db",
  });
});

// hourly (24h) or daily (7d) average AQI for the city
app.get("/cities/:id/history", async (c) => {
  const id = Number(c.req.param("id"));
  const range = c.req.query("range") === "7d" ? "7d" : "24h";
  const bucket = range === "7d" ? "day" : "hour";
  const interval = range === "7d" ? "7 days" : "24 hours";
  const { rows } = await pool.query(
    `SELECT date_trunc($1, r.ts) AS t, ROUND(AVG(r.aqi))::int AS aqi
       FROM readings r
       JOIN stations s ON s.id = r.station_id
      WHERE s.city_id = $2 AND r.ts >= now() - $3::interval AND r.aqi IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
    [bucket, id, interval]
  );
  return c.json(rows.map((x) => ({ t: x.t, aqi: x.aqi })));
});

// naive projection from recent slope + safe windows (aqi < 100)
app.get("/cities/:id/forecast", async (c) => {
  const id = Number(c.req.param("id"));
  const { rows } = await pool.query(
    `SELECT date_trunc('hour', r.ts) AS t, ROUND(AVG(r.aqi))::int AS aqi
       FROM readings r
       JOIN stations s ON s.id = r.station_id
      WHERE s.city_id = $1 AND r.ts >= now() - interval '12 hours' AND r.aqi IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
    [id]
  );
  if (rows.length < 2) return c.json({ points: [], safeWindows: [] });
  const vals = rows.map((r) => r.aqi as number);
  const last = vals[vals.length - 1];
  // average hourly delta over the window
  let delta = 0;
  for (let i = 1; i < vals.length; i++) delta += vals[i] - vals[i - 1];
  delta = delta / (vals.length - 1);
  const points: { t: string; aqi: number; projected: boolean }[] = [];
  const now = new Date();
  for (let h = 1; h <= 6; h++) {
    const aqi = Math.max(0, Math.round(last + delta * h));
    points.push({
      t: new Date(now.getTime() + h * 3600_000).toISOString(),
      aqi, projected: true,
    });
  }
  const safeWindows = points.filter((p) => p.aqi < 100).map((p) => p.t);
  return c.json({ current: last, trend: delta >= 0 ? "worsening" : "improving", points, safeWindows });
});

app.post("/cities/:id/subscribe", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const threshold = Number(body.threshold ?? 150);
  const { rows } = await pool.query(
    `INSERT INTO subscriptions (city_id, threshold) VALUES ($1,$2) RETURNING id`,
    [id, threshold]
  );
  return c.json({ ok: true, id: rows[0].id, threshold });
});

const port = Number(process.env.PORT || 3000);
migrate()
  .then(() => {
    serve({ fetch: app.fetch, port });
    console.log(`[api] listening on :${port}`);
  })
  .catch((e) => {
    console.error("[api] migration failed:", e);
    process.exit(1);
  });
