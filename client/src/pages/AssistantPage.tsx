import { useEffect, useRef, useState } from "react";
import { fetchSettings, sendChatMessage, type ChatMessage } from "../api/client";
import { IconSend } from "../components/icons";

const SUGGESTIONS = [
  "Summarize my unread emails",
  "What's on my calendar this week?",
  "Find the latest invoice in my files",
  "Draft a reply to my most recent email",
];

export function AssistantPage() {
  const [assistantName, setAssistantName] = useState("Assistant");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchSettings()
      .then((s) => setAssistantName(s.assistantName))
      .catch(() => {});
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
      <h1>{assistantName}</h1>
      <div className="chat-wrap">
        <div className="chat-scroll" ref={scrollRef}>
          {messages.length === 0 && (
            <>
              <p className="muted">
                Ask me anything about your connected email, calendar, and files. I can also
                draft emails for you (you always review and send them yourself).
              </p>
              <div className="chips">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              {m.content}
            </div>
          ))}
          {loading && <div className="bubble assistant muted">Thinking…</div>}
          {error && <p className="error">Error: {error}</p>}
        </div>
        <form
          className="row"
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Message ${assistantName}…`}
          />
          <button
            type="submit"
            disabled={loading}
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            <IconSend />
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
