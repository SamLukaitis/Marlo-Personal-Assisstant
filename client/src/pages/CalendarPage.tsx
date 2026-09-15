import { useEffect, useState } from "react";
import { fetchEvents, type CalendarEvent } from "../api/client";
import { isDateOnly, parseEventTime } from "../lib/eventTime";

// 11 colors so the mapping lines up conceptually with Google Calendar's own 11 event colors
// (server/src/providers/google.ts's colorForAccount uses the same `% 11` idea for the colorId
// it sets on events Marlowe creates) — not the same hex values, just the same account → slot
// idea, applied here to every account (Google and Microsoft) so the whole page is consistent.
const ACCOUNT_COLORS = [
  "#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#1abc9c",
  "#3498db", "#9b59b6", "#e84393", "#16a085", "#d35400", "#34495e",
];
function colorForAccount(accountId: number): string {
  return ACCOUNT_COLORS[accountId % ACCOUNT_COLORS.length];
}

function fmt(iso: string): string {
  if (!iso) return "";
  const d = parseEventTime(iso);
  if (isDateOnly(iso)) {
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }
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
                  <span className="badge-pill" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: colorForAccount(e.accountId),
                        flexShrink: 0,
                      }}
                    />
                    {e.accountEmail}
                  </span>
                </div>
                <div className="list-sub">
                  {e.allDay ? `${fmt(e.start)} · All day` : `${fmt(e.start)} → ${fmt(e.end)}`}
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
