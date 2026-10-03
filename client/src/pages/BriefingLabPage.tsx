import { useEffect, useState } from "react";
import {
  fetchBriefingLabProfiles,
  renderBriefingLab,
  type BriefingLabProfile,
  type BriefingLabRendered,
} from "../api/client";

// Ten invented users, each rendered through the real morning-briefing prompt, so its voice can be
// judged across setups that would otherwise need ten accounts and ten mornings to see: a quiet
// retiree at 9pm, a trader at 6am, a nomad with a flight in two days, a brand-new signup with
// nothing connected. See server/src/services/briefingPreview.ts — nothing here touches a real
// account, a real mailbox, or the database.
//
// Same gates as the WhatsApp Simulator: admin-only, staging-only (ENABLE_WHATSAPP_SIMULATOR).
//
// The profiles paint immediately (no model calls); the briefings arrive together a few seconds
// later. "Scramble" re-rolls every profile's day from a new seed — the seed is shown so a set you
// liked, or one that broke, can be typed back in and reproduced exactly.
export function BriefingLabPage() {
  const [profiles, setProfiles] = useState<BriefingLabProfile[]>([]);
  const [rendered, setRendered] = useState<Record<string, BriefingLabRendered>>({});
  const [seed, setSeed] = useState<number>(1);
  const [seedInput, setSeedInput] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFacts, setShowFacts] = useState<Record<string, boolean>>({});

  async function loadProfiles(s: number) {
    setError(null);
    try {
      const r = await fetchBriefingLabProfiles(s);
      setProfiles(r.profiles);
      setSeed(r.seed);
      setSeedInput(String(r.seed));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    loadProfiles(1);
  }, []);

  async function render(opts: { seed?: number; scramble?: boolean }) {
    if (busy) return;
    setBusy(true);
    setError(null);
    // Clear rather than leave the previous run's text under the new profiles — a stale briefing
    // beside a freshly scrambled fact set is worse than an empty card.
    setRendered({});
    try {
      const r = await renderBriefingLab(opts);
      setSeed(r.seed);
      setSeedInput(String(r.seed));
      setProfiles(r.profiles);
      setRendered(Object.fromEntries(r.profiles.map((p) => [p.id, p])));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function applySeed() {
    const n = Number(seedInput);
    if (!Number.isFinite(n) || n < 1) {
      setError("Seed must be a positive number.");
      return;
    }
    loadProfiles(n).then(() => render({ seed: n }));
  }

  // `scrollable` on both, as Settings and Portal do: .main defaults to height:100vh with
  // overflow:hidden for pages that fit one screen and scroll inside their own panel (the chat and
  // simulator pages). This one is a long stack of ten cards, so without it everything past the
  // first screen is simply clipped with no way to reach it.
  return (
    <div className="main scrollable">
      <div className="main-inner scrollable">
        <div className="page-header">
          <h1 className="heading-font">Briefing Lab</h1>
        </div>
        <p className="muted" style={{ marginTop: -8, marginBottom: 16 }}>
          Ten invented users run through the real morning-briefing prompt. Nothing here is a real account and
          no mailbox is read — the point is to see how the briefing reads across setups without waiting for
          ten mornings.
        </p>

        <div className="row" style={{ gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn-primary" type="button" onClick={() => render({ seed })} disabled={busy}>
            {busy ? "Writing ten briefings…" : "Render all ten"}
          </button>
          <button className="btn-secondary" type="button" onClick={() => render({ scramble: true })} disabled={busy}>
            Scramble
          </button>
          <span className="muted" style={{ fontSize: 12 }}>seed</span>
          <input
            className="input-clean"
            value={seedInput}
            onChange={(e) => setSeedInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applySeed()}
            style={{ maxWidth: 90 }}
            disabled={busy}
          />
          <button className="btn-secondary" type="button" onClick={applySeed} disabled={busy}>
            Use seed
          </button>
        </div>
        {error && <p className="error">Error: {error}</p>}

        {profiles.map((p) => {
          const out = rendered[p.id];
          const open = showFacts[p.id] ?? false;
          return (
            <div className="card card-padded" key={p.id} style={{ marginBottom: 14 }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <strong>{p.label}</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  {p.day.localTime} · {p.day.localWeekday}
                  {out ? ` · ${out.wordCount} words` : ""}
                  {out?.quiet ? " · quiet day" : ""}
                  {/* The cap the prompt states. Flagged here because the model has overshot it
                      before, and a rewrite that reads well but runs long is easy to miss by eye. */}
                  {out && out.wordCount > 90 ? " · OVER 90" : ""}
                </span>
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 4, marginBottom: 10 }}>{p.tests}</p>

              {out ? (
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{out.text}</div>
              ) : (
                <div className="muted">{busy ? "…" : "Not rendered yet."}</div>
              )}

              <button
                className="chip-minimal"
                type="button"
                style={{ marginTop: 10 }}
                onClick={() => setShowFacts((prev) => ({ ...prev, [p.id]: !open }))}
              >
                {open ? "Hide the facts it was given" : "Show the facts it was given"}
              </button>
              {open && (
                <div className="muted" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.6 }}>
                  <div>
                    <strong>Name:</strong> {p.voice.userName || "(none set)"} · <strong>Persona:</strong>{" "}
                    {p.voice.persona || "(none)"}
                  </div>
                  {p.day.location && <div>{p.day.location}</div>}
                  {p.day.weather && (
                    <div>
                      Weather in {p.day.weather.place}: {p.day.weather.condition}, {p.day.weather.tempC}°C (high{" "}
                      {p.day.weather.highC}, low {p.day.weather.lowC})
                    </div>
                  )}
                  {p.day.quotes.length > 0 && (
                    <div>
                      Markets:{" "}
                      {p.day.quotes
                        .map((q) => `${q.name} ${q.price} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent}%)`)
                        .join("; ")}
                    </div>
                  )}
                  <div>
                    Unread today ({p.day.unread.count}):{" "}
                    {p.day.unread.shown.map((m) => `"${m.subject}" from ${m.from}`).join("; ") || "none"}
                  </div>
                  <div>Today: {p.day.todayEvents.join("; ") || "nothing scheduled"}</div>
                  <div>Next 3 days: {p.day.upcomingEvents.join("; ") || "none"}</div>
                  <div>
                    Needs a reply: {p.day.flagged.map((m) => `"${m.subject}" from ${m.from}`).join("; ") || "none"}
                  </div>
                  {p.day.news.length > 0 && (
                    <div>News: {p.day.news.map((h) => `[${h.topic}] ${h.title}`).join("; ")}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
