import { useEffect, useState } from "react";
import { fetchEvents, type CalendarEvent } from "../api/client";

function fmt(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function CalendarPage() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchEvents(days)
      .then(setEvents)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [days]);

  return (
    <div className="main">
      <div className="main-inner">
        <div className="page-header">
          <h1 className="heading-font">Calendar</h1>
          <div className="segmented-control">
            {[7, 14, 30].map((d) => (
              <button
                key={d}
                className={`segmented-btn${d === days ? " active" : ""}`}
                onClick={() => setDays(d)}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>

        <div className="card" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {loading && <p className="muted" style={{ padding: 16 }}>Loading…</p>}
          {error && <p className="error" style={{ padding: 16 }}>{error}</p>}
          {!loading && !error && events.length === 0 && (
            <p className="muted" style={{ padding: 16 }}>
              No upcoming events — connect an account on the Setup page.
            </p>
          )}
          {events.map((e) => (
            <div key={`${e.accountId}-${e.id}`} className="data-row data-row-hover">
              <a href={e.link} target="_blank" rel="noreferrer" style={{ padding: "0 16px" }}>
                <div className="list-title">
                  <span>{e.title}</span>
                  <span className="badge-pill">{e.accountEmail}</span>
                </div>
                <div className="list-sub">
                  {fmt(e.start)} → {fmt(e.end)}
                  {e.location ? ` · ${e.location}` : ""}
                </div>
              </a>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
