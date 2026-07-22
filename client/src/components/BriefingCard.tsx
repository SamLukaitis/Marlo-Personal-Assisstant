import { useEffect, useState } from "react";
import {
  fetchBriefing,
  fetchBriefingSettings,
  refreshBriefing,
  type Briefing,
} from "../api/client";

export function BriefingCard() {
  const [enabled, setEnabled] = useState(false);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchBriefingSettings()
      .then((s) => {
        setEnabled(s.enabled);
        if (!s.enabled) {
          setLoading(false);
          return;
        }
        return fetchBriefing()
          .then(setBriefing)
          .catch((err) => setError((err as Error).message));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (!enabled || (loading === false && !briefing && !error)) return null;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <strong style={{ fontSize: 13.5 }}>Today's briefing</strong>
        <button
          className="secondary"
          disabled={loading || refreshing}
          onClick={async () => {
            setRefreshing(true);
            setError(null);
            try {
              setBriefing(await refreshBriefing());
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setRefreshing(false);
            }
          }}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {briefing && (
        <p style={{ whiteSpace: "pre-wrap", fontSize: 13.75, margin: 0 }}>{briefing.content}</p>
      )}
    </div>
  );
}
