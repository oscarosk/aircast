import { useEffect, useMemo, useState } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";

const API = (import.meta as any).env.VITE_API_URL || "";

type City = { id: number; name: string; state?: string };
type Current = {
  cityId: number; name: string; aqi: number; category: string;
  pm25?: number; pm10?: number; no2?: number; o3?: number; ts?: string; source?: string;
};
type Point = { t: string; aqi: number };

// AQI band -> color + plain-language health line (active voice, from the reader's side)
function band(aqi: number) {
  if (aqi <= 50) return { color: "#4ade80", label: "Good", line: "Air's clean. Great day to be outside." };
  if (aqi <= 100) return { color: "#facc15", label: "Moderate", line: "Mostly fine. Sensitive groups, ease up on long exertion." };
  if (aqi <= 150) return { color: "#fb923c", label: "Unhealthy for sensitive groups", line: "At-risk groups should cut back on outdoor exertion." };
  if (aqi <= 200) return { color: "#f87171", label: "Unhealthy", line: "Keep outdoor time short. Mask up if you head out." };
  if (aqi <= 300) return { color: "#c084fc", label: "Very unhealthy", line: "Stay in where you can. Avoid outdoor exercise." };
  return { color: "#e11d64", label: "Hazardous", line: "Stay indoors, windows shut. Run a purifier if you have one." };
}

function useFetch<T>(url: string | null, deps: any[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    setLoading(true); setError(null);
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, deps);
  return { data, error, loading };
}

export default function App() {
  const { data: cities } = useFetch<City[]>(API ? `${API}/cities` : null, []);
  const [cityId, setCityId] = useState<number | null>(null);
  const [range, setRange] = useState<"24h" | "7d">("24h");

  useEffect(() => {
    if (cities && cities.length && cityId == null) setCityId(cities[0].id);
  }, [cities]);

  const { data: current, error: curErr } = useFetch<Current>(
    cityId && API ? `${API}/cities/${cityId}/current` : null, [cityId]
  );
  const { data: history } = useFetch<Point[]>(
    cityId && API ? `${API}/cities/${cityId}/history?range=${range}` : null, [cityId, range]
  );

  const b = current && typeof current.aqi === "number" ? band(current.aqi) : null;

  // page wears the air's mood
  const bg = b
    ? `radial-gradient(1100px 520px at 50% -8%, ${b.color}22, transparent 60%), #0b0f14`
    : "#0b0f14";

  const chartData = useMemo(
    () => (history || []).map((p) => ({
      label: new Date(p.t).toLocaleString([], range === "7d"
        ? { month: "short", day: "numeric" }
        : { hour: "numeric" }),
      aqi: p.aqi,
    })),
    [history, range]
  );

  return (
    <div className="page" style={{ background: bg }}>
      <header className="top">
        <div className="brand">
          <span className="dot" style={{ background: b?.color || "#4ade80" }} />
          <span className="word">AirCast</span>
          <span className="tag">live air where you live</span>
        </div>
        <nav className="cities">
          {(cities || []).map((c) => (
            <button
              key={c.id}
              className={"pill" + (c.id === cityId ? " active" : "")}
              onClick={() => setCityId(c.id)}
            >
              {c.name}
            </button>
          ))}
        </nav>
      </header>

      {!API && (
        <div className="notice">Set <code>VITE_API_URL</code> on the app service to your API's public URL, then redeploy.</div>
      )}

      <main className="grid">
        <section className="hero card">
          {curErr || !current || typeof current.aqi !== "number" ? (
            <div className="empty">
              <h2>No readings yet</h2>
              <p>The ingestor pulls fresh data every 10 minutes. Give it a moment, then refresh.</p>
            </div>
          ) : (
            <>
              <div className="hero-main">
                <div className="aqi" style={{ color: b!.color }}>{current.aqi}</div>
                <div className="hero-meta">
                  <div className="cat" style={{ color: b!.color }}>{b!.label}</div>
                  <div className="place">{current.name}</div>
                  <p className="line">{b!.line}</p>
                  {current.ts && (
                    <div className="stamp">
                      Updated {new Date(current.ts).toLocaleString([], { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}
                    </div>
                  )}
                </div>
              </div>
              <div className="pollutants">
                {[
                  ["PM2.5", current.pm25, "µg/m³"],
                  ["PM10", current.pm10, "µg/m³"],
                  ["NO₂", current.no2, "µg/m³"],
                  ["O₃", current.o3, "µg/m³"],
                ].map(([k, v, u]) => (
                  <div className="poll" key={k as string}>
                    <div className="poll-k">{k}</div>
                    <div className="poll-v">{v == null ? "—" : Math.round(v as number)}<span>{u}</span></div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        <section className="card trend">
          <div className="trend-head">
            <h3>AQI trend</h3>
            <div className="toggle">
              <button className={range === "24h" ? "on" : ""} onClick={() => setRange("24h")}>24h</button>
              <button className={range === "7d" ? "on" : ""} onClick={() => setRange("7d")}>7d</button>
            </div>
          </div>
          {chartData.length ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={chartData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={b?.color || "#4ade80"} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={b?.color || "#4ade80"} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#ffffff10" vertical={false} />
                <XAxis dataKey="label" stroke="#6b7785" fontSize={11} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis stroke="#6b7785" fontSize={11} tickLine={false} axisLine={false} width={40} />
                <Tooltip
                  contentStyle={{ background: "#0f141c", border: "1px solid #ffffff14", borderRadius: 10, color: "#e6edf3" }}
                  labelStyle={{ color: "#8a97a6" }}
                />
                <Area type="monotone" dataKey="aqi" stroke={b?.color || "#4ade80"} strokeWidth={2} fill="url(#g)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty small"><p>Trend fills in as readings accumulate.</p></div>
          )}
        </section>

        <section className="card compare">
          <h3>Across cities</h3>
          <CityCompare cities={cities || []} activeId={cityId} onPick={setCityId} />
        </section>
      </main>

      <footer className="how">
        <strong>How AirCast works:</strong> a private ingestor pulls OpenAQ readings for each city every 10 minutes,
        computes US-EPA AQI, and writes a Postgres time-series; the latest snapshot is cached in Valkey and served to this
        dashboard by the API. Five services on Zerops, wired over the private network.
      </footer>
    </div>
  );
}

function CityCompare({ cities, activeId, onPick }: { cities: City[]; activeId: number | null; onPick: (id: number) => void }) {
  const [rows, setRows] = useState<Current[]>([]);
  useEffect(() => {
    let alive = true;
    Promise.all(
      cities.map((c) =>
        fetch(`${API}/cities/${c.id}/current`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      )
    ).then((res) => {
      if (!alive) return;
      const ok = res.filter((x): x is Current => x && typeof x.aqi === "number");
      ok.sort((a, b) => b.aqi - a.aqi);
      setRows(ok);
    });
    return () => { alive = false; };
  }, [cities.map((c) => c.id).join(",")]);

  if (!rows.length) return <div className="empty small"><p>Comparison appears once cities report.</p></div>;
  return (
    <div className="compare-list">
      {rows.map((r) => {
        const bb = band(r.aqi);
        return (
          <button key={r.cityId} className={"crow" + (r.cityId === activeId ? " active" : "")} onClick={() => onPick(r.cityId)}>
            <span className="cname">{r.name}</span>
            <span className="cbar"><span style={{ width: `${Math.min(100, (r.aqi / 300) * 100)}%`, background: bb.color }} /></span>
            <span className="cval" style={{ color: bb.color }}>{r.aqi}</span>
          </button>
        );
      })}
    </div>
  );
}
