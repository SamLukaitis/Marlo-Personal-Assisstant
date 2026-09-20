import { useEffect, useRef, useState } from "react";
import { fetchAdminMessages, sendWhatsAppSimMessage, type AdminTimelineEntry } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { IconSend } from "../components/icons";

const POLL_MS = 1500;

// A stand-in for the real WhatsApp Business number: exercises the exact same inbound pipeline
// (registration, debounced batching, choice buttons, link handling) real WhatsApp messages hit,
// without ever touching Meta's API or the live business number — see whatsappSimRoutes.ts and
// providers/whatsapp.ts's isSimulatedPhone guard. Only reachable when the server has
// ENABLE_WHATSAPP_SIMULATOR set (staging) and the signed-in account is an admin — see Sidebar.tsx.
export function WhatsAppSimPage() {
  const { user } = useAuth();
  const phone = user ? `999000${user.id}` : null;

  const [timeline, setTimeline] = useState<AdminTimelineEntry[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function poll() {
    if (!phone) return;
    try {
      const { timeline: t } = await fetchAdminMessages(phone);
      setTimeline(t);
      // Once the newest entry is an assistant message, the debounced reply has landed.
      if (t.length > 0 && t[t.length - 1].kind === "message" && t[t.length - 1].role === "assistant") {
        setWaiting(false);
      }
    } catch {
      // First send hasn't happened yet (no account bound to the sim number) — not an error.
    }
  }

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [timeline, waiting]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setWaiting(true);
    setError(null);
    setInput("");
    try {
      await sendWhatsAppSimMessage(trimmed);
      await poll();
    } catch (err) {
      setError((err as Error).message);
      setWaiting(false);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="main">
      <div className="main-inner">
        <div className="page-header">
          <h1 className="heading-font">WhatsApp Simulator</h1>
        </div>
        <p className="muted" style={{ marginTop: -8, marginBottom: 16 }}>
          Sends messages through the real WhatsApp pipeline on reserved test number{" "}
          {phone ?? "…"} — nothing here reaches Meta or the live business number.
        </p>

        <div className="chat-panel">
          <div className="chat-scroll" ref={scrollRef}>
            {timeline.length === 0 && !waiting && (
              <p className="muted" style={{ marginBottom: 12 }}>
                Type a message below exactly as a WhatsApp user would — "hi", a question, a link, etc.
              </p>
            )}
            {timeline.map((entry, i) =>
              entry.kind === "message" ? (
                <div key={i} className={`chat-bubble ${entry.role}`}>
                  {entry.content}
                </div>
              ) : (
                <p key={i} className="muted" style={{ textAlign: "center", fontSize: 12, margin: "8px 0" }}>
                  — onboarding step: {entry.step} ({entry.event}) —
                </p>
              )
            )}
            {waiting && <div className="chat-bubble assistant muted">Typing…</div>}
            {error && <p className="error">Error: {error}</p>}
          </div>
          <div className="chat-input-row">
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
            >
              <input
                className="input-clean"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Message as a WhatsApp user…"
              />
              <button className="btn-primary" type="submit" disabled={sending}>
                <span className="briefing-toggle-label">Send</span>
                <IconSend />
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
