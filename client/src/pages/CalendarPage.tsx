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
      <h1>Calendar</h1>
      <div className="row" style={{ marginBottom: 16 }}>
        {[7, 14, 30].map((d) => (
          <button
            key={d}
            className={d === days ? "" : "secondary"}
            onClick={() => setDays(d)}
          >
            Next {d} days
          </button>
        ))}
      </div>

      <div className="card">
        {loading && <p className="muted">Loading…</p>}
        {error && <p className="error">{error}</p>}
        {!loading && !error && events.length === 0 && (
          <p className="muted">No upcoming events — connect an account on the Setup page.</p>
        )}
        {events.map((e) => (
          <div key={`${e.accountId}-${e.id}`} className="list-item">
            <a href={e.link} target="_blank" rel="noreferrer">
              <div className="title">
                <span>{e.title}</span>
                <span className="badge">{e.accountEmail}</span>
              </div>
              <div className="sub">
                {fmt(e.start)} → {fmt(e.end)}
                {e.location ? ` · ${e.location}` : ""}
              </div>
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
