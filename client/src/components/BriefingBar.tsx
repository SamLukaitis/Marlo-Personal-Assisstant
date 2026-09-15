import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchBriefing,
  fetchBriefingSettings,
  refreshBriefing,
  fetchMessages,
  fetchEvents,
  fetchBriefingFeed,
  type Briefing,
  type BriefingFeed,
  type UnifiedMessage,
  type CalendarEvent,
} from "../api/client";
import { IconChevronDown, IconRefresh } from "./icons";
import { isDateOnly, parseEventTime } from "../lib/eventTime";

function fmtTime(iso: string): string {
  if (isDateOnly(iso)) return "All day";
  return parseEventTime(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function isToday(iso: string): boolean {
  const d = parseEventTime(iso);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

const EMPTY_FEED: BriefingFeed = { headlines: [], quotes: [], weather: null };

interface BriefingBarProps {
  expanded: boolean;
  onToggle: () => void;
}

// Three segments: Unread, Calendar, and Today. The first two are the user's own data; the third
// is the outside world — weather, markets, headlines, whichever they opted into. It deliberately
// never falls back to restating the inbox: a segment that repeats the segment next to it is
// wasted space, so with nothing opted in it says so and links to where you choose.
export function BriefingBar({ expanded, onToggle }: BriefingBarProps) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [feed, setFeed] = useState<BriefingFeed>(EMPTY_FEED);

  useEffect(() => {
    let cancelled = false;
    fetchBriefingSettings()
      .then(async (s) => {
        if (cancelled) return;
        setEnabled(s.enabled);
        if (!s.enabled) return;

        const [b, m, e, f] = await Promise.all([
          fetchBriefing().catch((err) => {
            setError((err as Error).message);
            return null;
          }),
          fetchMessages().catch(() => []),
          fetchEvents(7).catch(() => []),
          fetchBriefingFeed().catch(() => EMPTY_FEED),
        ]);
        if (cancelled) return;
        setBriefing(b);
        setMessages(m);
        setEvents(e);
        setFeed(f);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      const [b, m, e, f] = await Promise.all([
        refreshBriefing(),
        fetchMessages(),
        fetchEvents(7),
        fetchBriefingFeed().catch(() => EMPTY_FEED),
      ]);
      setBriefing(b);
      setMessages(m);
      setEvents(e);
      setFeed(f);
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

  const { weather, quotes, headlines } = feed;
  const hasFeed = !!weather || quotes.length > 0 || headlines.length > 0;

  // Weather leads when present — it's the thing people actually check first — then markets, then
  // the top headline.
  const todayLabel = weather ? "Weather" : quotes.length ? "Markets" : headlines.length ? "Headlines" : "Today";
  const todayValue = weather
    ? `${weather.tempC}°C ${weather.condition}, high ${weather.highC}°`
    : quotes.length
    ? quotes.map((q) => `${q.name} ${signed(q.changePercent)}`).join(" · ")
    : headlines.length
    ? headlines[0].title
    : null;

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
                <strong>{fmtTime(nextEvent.start)}</strong> · {nextEvent.title}
              </>
            ) : (
              "Nothing upcoming"
            )}
          </p>
        </div>
        <div className="briefing-divider" />
        <div className="briefing-segment">
          <span className="briefing-segment-label">{todayLabel}</span>
          <p className="briefing-segment-value">
            {todayValue ?? (
              <Link to="/settings?section=briefing" className="briefing-inline-link">
                Choose what to show here
              </Link>
            )}
          </p>
        </div>
        <div className="briefing-toggle-slot">
          <button
            className="briefing-toggle"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse briefing" : "Expand briefing"}
          >
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
              <ul className="briefing-list">
                {unread.slice(0, 5).map((m) => (
                  <li key={`${m.accountId}-${m.id}`}>
                    <span className="briefing-list-title">{m.from}</span>
                    <span className="briefing-list-sub">{m.subject}</span>
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
              <ul className="briefing-list">
                {todayEvents.slice(0, 5).map((e) => (
                  <li key={`${e.accountId}-${e.id}`} className="briefing-list-row">
                    <span className="briefing-list-time">{fmtTime(e.start)}</span>
                    <span className="briefing-list-sub">{e.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3>{hasFeed ? "Around you" : "Your feed"}</h3>
            {!hasFeed ? (
              <p className="muted">
                Nothing switched on yet.{" "}
                <Link to="/settings?section=briefing" className="briefing-inline-link">
                  Pick your sources
                </Link>
                .
              </p>
            ) : (
              <ul className="briefing-list">
                {weather && (
                  <li>
                    <span className="briefing-list-title">{weather.place}</span>
                    <span className="briefing-list-sub">
                      {weather.condition}, {weather.tempC}°C · high {weather.highC}° / low{" "}
                      {weather.lowC}°
                    </span>
                  </li>
                )}
                {quotes.map((q) => (
                  <li key={q.symbol} className="briefing-list-row">
                    <span className="briefing-list-title">{q.name}</span>
                    <span className={`briefing-delta${q.changePercent >= 0 ? " up" : " down"}`}>
                      {signed(q.changePercent)}
                    </span>
                  </li>
                ))}
                {headlines.slice(0, 4).map((h, i) => (
                  <li key={`${h.topic}-${i}`}>
                    <span className="badge-pill">{h.topic}</span>
                    <span className="briefing-list-sub">{h.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {(briefing || error) && (
          <div className="briefing-prose">
            <h3>This morning</h3>
            {error ? <p className="error">{error}</p> : <p>{briefing?.content}</p>}
          </div>
        )}

        <div className="briefing-details-footer">
          <button className="briefing-toggle" disabled={refreshing} onClick={handleRefresh}>
            <IconRefresh />
            <span className="briefing-toggle-label">{refreshing ? "Refreshing…" : "Refresh"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
