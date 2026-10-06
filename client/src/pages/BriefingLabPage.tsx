import { useEffect, useState } from "react";
import {
  fetchBriefingLabProfiles,
  renderBriefingLab,
  type BriefingLabProfile,
  type BriefingLabRendered,
  type DigestLabProfile,
  type DigestLabRendered,
  type LabKind,
} from "../api/client";

// Ten invented users, rendered through the real prompts for both of Marlowe's proactive messages —
// the morning briefing and the evening recap of who emailed. They share a voice
// (server/src/services/proactiveVoice.ts), so they're reviewed side by side here rather than in two
// separate tools: a change to the shared register moves both, and this is where you'd catch it.
//
// Nothing here touches a real account, reads a real mailbox, or writes to the database. Every name,
// sender and headline is invented. See server/src/services/briefingPreview.ts.
//
// Same gates as the WhatsApp Simulator: admin-only, staging-only (ENABLE_WHATSAPP_SIMULATOR).
type AnyProfile = BriefingLabProfile | DigestLabProfile;
type AnyRendered = BriefingLabRendered | DigestLabRendered;

const WORD_CAP: Record<LabKind, number> = { briefing: 70, digest: 50 };

const BLURB: Record<LabKind, string> = {
  briefing: "Sent each morning. Covers mail, calendar, and anything waiting on a reply.",
  digest: "Sent each evening. Only covers who emailed — it has no calendar, weather or news.",
};

export function BriefingLabPage() {
  const [kind, setKind] = useState<LabKind>("briefing");
  const [profiles, setProfiles] = useState<AnyProfile[]>([]);
  const [rendered, setRendered] = useState<Record<string, AnyRendered>>({});
  const [seed, setSeed] = useState(1);
  const [seedInput, setSeedInput] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFacts, setShowFacts] = useState<Record<string, boolean>>({});

  async function loadProfiles(k: LabKind, s: number) {
    setError(null);
    try {
      const r = await fetchBriefingLabProfiles(k, s);
      setProfiles(r.profiles);
      setSeed(r.seed);
      setSeedInput(String(r.seed));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Switching kind clears the previous kind's text — a morning briefing sitting under an evening
  // recap's facts would be actively misleading.
  useEffect(() => {
    setRendered({});
    setShowFacts({});
    loadProfiles(kind, seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  async function render(opts: { seed?: number; scramble?: boolean }) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setRendered({});
    try {
      const r = await renderBriefingLab({ kind, ...opts });
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
    loadProfiles(kind, n).then(() => render({ seed: n }));
  }

  return (
    <div className="main scrollable">
      <div className="main-inner scrollable">
        <div className="page-header">
          <h1 className="heading-font">Briefing Lab</h1>
        </div>
        <p className="muted" style={{ marginTop: -8, marginBottom: 16 }}>
          Ten invented users run through the real prompts. Nothing here is a real account and no mailbox is
          read — the point is to see how these read across setups without waiting for ten mornings.
        </p>

        <div className="chips" style={{ marginBottom: 12 }}>
          {(["briefing", "digest"] as LabKind[]).map((k) => (
            <button
              key={k}
              type="button"
              className={k === kind ? "chip-minimal active" : "chip-minimal"}
              disabled={busy}
              onClick={() => setKind(k)}
            >
              {k === "briefing" ? "Morning briefing" : "Evening recap"}
            </button>
          ))}
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 14 }}>
          {BLURB[kind]}
        </p>

        <div className="row" style={{ gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn-primary" type="button" onClick={() => render({ seed })} disabled={busy}>
            {busy ? "Writing ten…" : "Render all ten"}
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
          // A recap profile with nothing held sends nothing at all. That's correct — unlike the old
          // briefing, the recap has always stayed silent on an empty day — so say so plainly.
          const silent = p.day === null;
          return (
            <div className="card card-padded" key={p.id} style={{ marginBottom: 14 }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <strong>{p.label}</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  {p.day ? `${p.day.localTime} · ${p.day.localWeekday}` : "nothing held"}
                  {out && !silent ? ` · ${out.wordCount} words` : ""}
                  {"quiet" in p && (p as BriefingLabProfile & { quiet?: boolean }).quiet ? " · quiet day" : ""}
                  {out && out.wordCount > WORD_CAP[kind] ? ` · OVER ${WORD_CAP[kind]}` : ""}
                </span>
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 4, marginBottom: 10 }}>{p.tests}</p>

              {silent ? (
                <div className="muted">No recap sent — nothing was held for them today.</div>
              ) : out ? (
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{out.text}</div>
              ) : (
                <div className="muted">{busy ? "…" : "Not rendered yet."}</div>
              )}

              {!silent && (
                <button
                  className="chip-minimal"
                  type="button"
                  style={{ marginTop: 10 }}
                  onClick={() => setShowFacts((prev) => ({ ...prev, [p.id]: !open }))}
                >
                  {open ? "Hide the facts it was given" : "Show the facts it was given"}
                </button>
              )}
              {open && !silent && <Facts kind={kind} profile={p} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The exact facts the model was handed. Worth opening whenever a message says something odd —
// usually the facts explain it, and if they don't, that's a fabrication worth reporting.
// `kind` rather than sniffing the object's shape: the two day types share most of their field names
// and a structural guess here silently renders the wrong panel.
function Facts({ kind, profile }: { kind: LabKind; profile: AnyProfile }) {
  const day = profile.day;
  if (!day) return null;
  const common = (
    <div>
      <strong>Name:</strong> {profile.voice.userName || "(none set)"} · <strong>Persona:</strong>{" "}
      {profile.voice.persona || "(none)"}
    </div>
  );

  if (kind === "digest") {
    const d = day as NonNullable<DigestLabProfile["day"]>;
    return (
      <div className="muted" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.6 }}>
        {common}
        <div>
          {d.total} email{d.total === 1 ? "" : "s"} from {d.senders.length}{" "}
          {d.senders.length === 1 ? "person" : "people"}
        </div>
        {d.senders.map((g, i) => (
          <div key={i}>
            — {g.name}: "{g.subject}"{g.count > 1 ? ` (and ${g.count - 1} more on the same thread)` : ""}
          </div>
        ))}
      </div>
    );
  }

  const b = day as NonNullable<BriefingLabProfile["day"]>;
  return (
    <div className="muted" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.6 }}>
      {common}
      {b.location && <div>{b.location}</div>}
      {b.weather && (
        <div>
          Weather in {b.weather.place}: {b.weather.condition}, {b.weather.tempC}°C (high {b.weather.highC}, low{" "}
          {b.weather.lowC})
        </div>
      )}
      {b.quotes.length > 0 && (
        <div>
          Markets:{" "}
          {b.quotes
            .map((q) => `${q.name} ${q.price} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent}%)`)
            .join("; ")}
        </div>
      )}
      <div>
        Unread today ({b.unread.count}):{" "}
        {b.unread.shown.map((m) => `"${m.subject}" from ${m.from}`).join("; ") || "none"}
      </div>
      <div>Today: {b.todayEvents.join("; ") || "nothing scheduled"}</div>
      <div>Next 3 days: {b.upcomingEvents.join("; ") || "none"}</div>
      <div>Needs a reply: {b.flagged.map((m) => `"${m.subject}" from ${m.from}`).join("; ") || "none"}</div>
      {b.news.length > 0 && <div>News: {b.news.map((h) => `[${h.topic}] ${h.title}`).join("; ")}</div>}
    </div>
  );
}
