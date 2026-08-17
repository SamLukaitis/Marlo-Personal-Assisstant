import { useEffect, useRef, useState } from "react";
import { fetchSettings, sendChatMessage, type ChatMessage, type Settings } from "../api/client";
import { IconSend, IconSettings } from "../components/icons";
import { BriefingBar } from "../components/BriefingBar";
import { AssistantConfigModal } from "../components/AssistantConfigModal";

const SUGGESTIONS = [
  "Summarize my unread emails",
  "What's on my calendar this week?",
  "Find the latest invoice in my files",
  "Draft a reply to my most recent email",
];

export function AssistantPage() {
  const [settings, setSettings] = useState<Settings>({ assistantName: "Assistant", persona: "" });
  const [configOpen, setConfigOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [briefingExpanded, setBriefingExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const assistantName = settings.assistantName;

  useEffect(() => {
    fetchSettings().then(setSettings).catch(() => {});
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const next: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError(null);

    try {
      const reply = await sendChatMessage(next);
      setMessages([...next, { role: "assistant", content: reply }]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="main">
      <div className="main-inner">
        <div className="page-header">
          <h1 className="heading-font">{assistantName}</h1>
          <button className="title-action" onClick={() => setConfigOpen(true)}>
            <IconSettings />
            Configure
          </button>
        </div>

        <BriefingBar expanded={briefingExpanded} onToggle={() => setBriefingExpanded((v) => !v)} />

        <div className="chat-panel">
          <div className="chat-scroll" ref={scrollRef}>
            {messages.length === 0 && (
              <>
                <p className="muted" style={{ marginBottom: 12 }}>
                  Ask me anything about your connected email, calendar, and files. I can also
                  draft emails for you (you always review and send them yourself).
                </p>
                <div className="chips">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="chip-minimal" onClick={() => send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`chat-bubble ${m.role}`}>
                {m.content}
              </div>
            ))}
            {loading && <div className="chat-bubble assistant muted">Thinking…</div>}
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
                onChange={(e) => {
                  setInput(e.target.value);
                  setBriefingExpanded(false);
                }}
                onFocus={() => setBriefingExpanded(false)}
                placeholder={`Message ${assistantName}…`}
              />
              <button className="btn-primary" type="submit" disabled={loading}>
                <span className="briefing-toggle-label">Send</span>
                <IconSend />
              </button>
            </form>
          </div>
        </div>

        <footer className="page-footer">
          <span>Connected to your accounts</span>
          <span>{assistantName}</span>
        </footer>

        {configOpen && (
          <AssistantConfigModal
            initial={settings}
            onClose={() => setConfigOpen(false)}
            onSaved={setSettings}
          />
        )}
      </div>
    </div>
  );
}
