import { useEffect, useRef, useState } from "react";
import { sendHelpChatMessage, type HelpChatTurn } from "../api/client";
import { prefersReducedMotion } from "../lib/motionPrefs";
import "./HelpWidget.css";

interface DisplayTurn extends HelpChatTurn {
  id: number;
}

const GREETING: DisplayTurn = {
  id: 0,
  role: "assistant",
  text: "Hi — I can answer questions about Marlowe. What would you like to know?",
};

/** Floating help chat for the logged-out marketing homepage. Public/unauthenticated: it never
 *  sees real account data, only ever talks about the product in general terms (see
 *  server/src/ai/assistant.ts's getHelpChatReply). */
export function HelpWidget() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<DisplayTurn[]>([GREETING]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(1);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [turns, open]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const message = draft.trim();
    if (!message || sending) return;

    setError(null);
    setDraft("");
    const userTurn: DisplayTurn = { id: nextId.current++, role: "user", text: message };
    const history: HelpChatTurn[] = turns.map(({ role, text }) => ({ role, text }));
    setTurns((prev) => [...prev, userTurn]);
    setSending(true);
    try {
      const reply = await sendHelpChatMessage(message, history);
      setTurns((prev) => [...prev, { id: nextId.current++, role: "assistant", text: reply }]);
    } catch {
      setError("Couldn't reach the help assistant — try again in a moment.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={`help-widget${open ? " is-open" : ""}`}>
      {open && (
        <div className="help-panel" role="dialog" aria-label="Help chat">
          <div className="help-panel-head">
            <span>Ask Marlowe</span>
            <button type="button" className="help-close" onClick={() => setOpen(false)} aria-label="Close help chat">
              ×
            </button>
          </div>
          <div className="help-panel-body" ref={listRef}>
            {turns.map((t) => (
              <div key={t.id} className={`help-bubble help-bubble-${t.role}`}>
                {t.text}
              </div>
            ))}
            {sending && (
              <div className="help-bubble help-bubble-assistant help-typing" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            )}
            {error && <div className="help-error">{error}</div>}
          </div>
          <form className="help-panel-form" onSubmit={handleSend}>
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask a question…"
              maxLength={1000}
              disabled={sending}
              aria-label="Your question"
            />
            <button type="submit" disabled={sending || !draft.trim()}>
              Send
            </button>
          </form>
        </div>
      )}
      <button
        type="button"
        className="help-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "Close help chat" : "Open help chat"}
      >
        {open ? "×" : "?"}
      </button>
    </div>
  );
}
