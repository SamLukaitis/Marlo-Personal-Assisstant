import { useEffect, useState } from "react";
import {
  fetchBriefing,
  fetchBriefingSettings,
  refreshBriefing,
  fetchMessages,
  fetchEvents,
  type Briefing,
  type UnifiedMessage,
  type CalendarEvent,
} from "../api/client";
import { IconChevronDown, IconRefresh } from "./icons";

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

interface BriefingBarProps {
  expanded: boolean;
  onToggle: () => void;
}

// The confirmed design calls for three structured segments (Unread / Calendar / Updates) plus
// an expanded detail view listing individual emails/events/headlines. The app has real
// endpoints for unread mail and calendar events (fetchMessages/fetchEvents), so those two
// segments are backed by real data. There's no dedicated "news headlines" endpoint separate
// from the AI-written prose briefing (fetchBriefing) — rather than inventing one as part of a
// visual-only pass, the third segment and the expanded view's third column both surface that
// existing prose briefing instead of a literal headline list. Revisit if a structured
// news/briefing-data endpoint gets built later.
export function BriefingBar({ expanded, onToggle }: BriefingBarProps) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);

  useEffect(() => {
    fetchBriefingSettings()
      .then((s) => {
        setEnabled(s.enabled);
        if (!s.enabled) {
          setLoading(false);
          return;
        }
        return Promise.all([
          fetchBriefing().catch((err) => {
            setError((err as Error).message);
            return null;
          }),
          fetchMessages().catch(() => []),
          fetchEvents(7).catch(() => []),
        ]).then(([b, m, e]) => {
          setBriefing(b);
          setMessages(m);
          setEvents(e);
        });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      const [b, m, e] = await Promise.all([refreshBriefing(), fetchMessages(), fetchEvents(7)]);
      setBriefing(b);
      setMessages(m);
      setEvents(e);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  if (!enabled || loading) return null;

  const unread = messages.filter((m) => m.unread);
  const topUnread = unread[0];
  const todayEvents = events.filter((e) => isToday(e.start));
  const nextEvent = todayEvents[0] ?? events[0];

  return (
    <div className={`briefing-panel${expanded ? " is-expanded" : ""}`}>
      <div className="briefing-strip">
        <div className="briefing-segment">
          <span className="briefing-segment-label">Unread</span>
          <p className="briefing-segment-value">
            <strong>{unread.length} item{unread.length === 1 ? "" : "s"}</strong>
            {topUnread ? ` — ${topUnread.subject}` : ""}
          </p>
        </div>
        <div className="briefing-divider" />
        <div className="briefing-segment">
          <span className="briefing-segment-label">Calendar</span>
          <p className="briefing-segment-value">
            {nextEvent ? (
              <>
                <strong>{fmtTime(nextEvent.start)}</strong> ({todayEvents.length} today)
              </>
            ) : (
              "Nothing upcoming"
            )}
          </p>
        </div>
        <div className="briefing-divider" />
        <div className="briefing-segment">
          <span className="briefing-segment-label">Briefing</span>
          <p className="briefing-segment-value">
            {error ? "Unavailable" : briefing ? briefing.content.split("\n")[0] : "Not generated yet"}
          </p>
        </div>
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", paddingLeft: 4 }}>
          <button className="briefing-toggle" onClick={onToggle}>
            <span className="briefing-toggle-label">Detail</span>
            <IconChevronDown />
          </button>
        </div>
      </div>

      <div className="briefing-details">
        <div className="briefing-details-grid">
          <section>
            <h3>Unread mail</h3>
            {unread.length === 0 ? (
              <p className="muted">Nothing unread.</p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
                {unread.slice(0, 5).map((m) => (
                  <li key={`${m.accountId}-${m.id}`} style={{ fontSize: 12 }}>
                    <div style={{ fontWeight: 700 }}>{m.from}</div>
                    <div className="muted" style={{ fontSize: 11 }}>{m.subject}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3>Today's events</h3>
            {todayEvents.length === 0 ? (
              <p className="muted">Nothing scheduled today.</p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
                {todayEvents.slice(0, 5).map((e) => (
                  <li key={`${e.accountId}-${e.id}`} style={{ display: "flex", gap: 8, fontSize: 12 }}>
                    <span style={{ fontWeight: 700, flexShrink: 0 }}>{fmtTime(e.start)}</span>
                    <span className="muted">{e.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3>Briefing</h3>
            {error ? (
              <p className="error">{error}</p>
            ) : briefing ? (
              <p style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: 0 }}>{briefing.content}</p>
            ) : (
              <p className="muted">Not generated yet — hit Refresh.</p>
            )}
          </section>
        </div>
        <div style={{ padding: 16, borderTop: "1px solid var(--border-soft)", display: "flex", justifyContent: "flex-end" }}>
          <button
            className="briefing-toggle"
            disabled={refreshing}
            onClick={handleRefresh}
            style={{ background: "transparent" }}
          >
            <IconRefresh />
            <span className="briefing-toggle-label">{refreshing ? "Refreshing…" : "Refresh"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
