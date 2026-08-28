import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchCheckins,
  fetchTravelDays,
  type TravelCheckin,
  type TravelDaysResult,
} from "../api/client";
import { useTools } from "../context/ToolsContext";

// Travel used to live as a section inside Setup, which meant turning the tool on visibly changed
// nothing — the payoff was buried three screens deep in a settings page. It's a section of the
// hub now, and it appears in the sidebar only for people who asked for it.
export function TravelPage() {
  const { isEnabled, loaded } = useTools();
  const [checkins, setCheckins] = useState<TravelCheckin[]>([]);
  const [schengen, setSchengen] = useState<TravelDaysResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const enabled = isEnabled("travel");

  useEffect(() => {
    if (!loaded || !enabled) return;
    setLoading(true);
    Promise.all([fetchCheckins(), fetchTravelDays("schengen", 180)])
      .then(([c, s]) => {
        setCheckins(c);
        setSchengen(s);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [loaded, enabled]);

  if (!loaded) return null;

  if (!enabled) {
    return (
      <div className="main">
        <div className="main-inner">
          <div className="page-header">
            <h1 className="heading-font">Travel</h1>
          </div>
          <div className="card card-padded">
            <p className="muted" style={{ marginTop: 0 }}>
              The travel tracker isn't switched on for your hub.
            </p>
            <Link to="/settings?section=tools">
              <button className="btn-primary">Turn it on</button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const daysLeft = schengen ? Math.max(0, 90 - schengen.daysPresent) : null;

  return (
    <div className="main">
      <div className="main-inner">
        <div className="page-header">
          <h1 className="heading-font">Travel</h1>
        </div>

        {schengen && (
          <div className="stat-row">
            <div className="stat-card">
              <span className="stat-label">Schengen days used</span>
              <span className="stat-value">
                {schengen.daysPresent}
                <span className="stat-unit">/ 90</span>
              </span>
              <span className="stat-note">
                Rolling 180 days, {schengen.sinceDate} to {schengen.untilDate}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Days remaining</span>
              <span className="stat-value">{daysLeft}</span>
              <span className="stat-note">Before you hit the 90-day limit</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Check-ins on record</span>
              <span className="stat-value">{checkins.length}</span>
              <span className="stat-note">From your phone and saved documents</span>
            </div>
          </div>
        )}

        <h2>Check-in history</h2>
        <div className="card" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {loading && <p className="muted" style={{ padding: 16 }}>Loading…</p>}
          {error && <p className="error" style={{ padding: 16 }}>{error}</p>}
          {!loading && !error && checkins.length === 0 && (
            <p className="muted" style={{ padding: 16 }}>
              Nothing logged yet. Send a boarding pass or ticket to your assistant on WhatsApp and
              the trip gets recorded here automatically.
            </p>
          )}
          {checkins.map((c) => (
            <div key={c.id} className="data-row row" style={{ justifyContent: "space-between", padding: "0 16px" }}>
              <span style={{ fontSize: 13.5 }}>
                {c.city ? `${c.city}, ` : ""}
                {c.country ??
                  (c.latitude != null && c.longitude != null
                    ? `${c.latitude.toFixed(3)}, ${c.longitude.toFixed(3)}`
                    : "Unknown location")}{" "}
                <span className="badge-pill">
                  {c.source === "document" ? "from a document" : "from your phone"}
                </span>
              </span>
              <span className="muted" style={{ fontSize: 12.5 }}>
                {new Date(c.checkedInAt).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
