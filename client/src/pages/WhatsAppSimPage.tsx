import { useEffect, useRef, useState } from "react";
import {
  createWhatsAppSimTestUser,
  deleteWhatsAppSimTestUser,
  fetchWhatsAppSimTestUsers,
  fetchWhatsAppSimTranscript,
  sendWhatsAppSimMessage,
  type WhatsAppSimEntry,
  type WhatsAppSimInput,
  type WhatsAppSimTestUser,
} from "../api/client";
import { IconSend } from "../components/icons";

const POLL_MS = 1500;

// A stand-in for the real WhatsApp Business number: exercises the exact same inbound pipeline
// (registration, debounced batching, choice buttons, link handling) real WhatsApp messages hit,
// without ever touching Meta's API or the live business number — see whatsappSimRoutes.ts and
// providers/whatsapp.ts's isSimulatedPhone guard. Only reachable when the server has
// ENABLE_WHATSAPP_SIMULATOR set (staging) and the signed-in account is an admin — see Sidebar.tsx.
//
// "Me" chats as the signed-in account; a test user is a fresh, invited number that signs up from
// scratch, so onboarding can be tested without touching anyone's real account.
export function WhatsAppSimPage() {
  // null = the signed-in account's own sim number; otherwise a test user's phone.
  const [identity, setIdentity] = useState<string | null>(null);
  const [testUsers, setTestUsers] = useState<WhatsAppSimTestUser[]>([]);
  const [phone, setPhone] = useState<string | null>(null);
  const [entries, setEntries] = useState<WhatsAppSimEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function loadTestUsers() {
    try {
      setTestUsers(await fetchWhatsAppSimTestUsers());
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // A poll still in flight when the identity switches must not paint the old chat over the new one.
  const identityRef = useRef(identity);
  identityRef.current = identity;

  async function poll() {
    const requested = identity;
    try {
      const t = await fetchWhatsAppSimTranscript(requested ?? undefined);
      if (identityRef.current !== requested) return;
      setPhone(t.phone);
      setEntries(t.entries);
      // Once the newest entry is from Marlowe, the debounced reply has landed.
      if (t.entries.length > 0 && t.entries[t.entries.length - 1].role === "assistant") setWaiting(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    loadTestUsers();
  }, []);

  useEffect(() => {
    setEntries([]);
    setWaiting(false);
    setError(null);
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries, waiting]);

  async function send(message: WhatsAppSimInput) {
    if (busy) return;
    setBusy(true);
    setWaiting(true);
    setError(null);
    try {
      await sendWhatsAppSimMessage(message, identity ?? undefined);
      await poll();
    } catch (err) {
      setError((err as Error).message);
      setWaiting(false);
    } finally {
      setBusy(false);
    }
  }

  async function sendTyped() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    await send({ text });
  }

  // Uses the browser's real location rather than a fixed test pin: a shared pin also sets the
  // account's timezone (chatDispatch.handleLocation), and "Me" is the admin's real account.
  function shareLocation() {
    if (!navigator.geolocation) {
      setError("This browser can't share a location.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => void send({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      (err) => setError(`Couldn't get your location: ${err.message}`),
      { timeout: 10_000 }
    );
  }

  async function newTestUser() {
    setBusy(true);
    setError(null);
    try {
      const { phone: created } = await createWhatsAppSimTestUser();
      await loadTestUsers();
      setIdentity(created);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteTestUser() {
    if (!identity) return;
    if (!window.confirm(`Delete test user ${identity}? This wipes its account and everything in it.`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteWhatsAppSimTestUser(identity);
      setIdentity(null);
      await loadTestUsers();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="main">
      <div className="main-inner">
        <div className="page-header">
          <h1 className="heading-font">WhatsApp Simulator</h1>
        </div>
        <p className="muted" style={{ marginTop: -8, marginBottom: 16 }}>
          Sends messages through the real WhatsApp pipeline on reserved test numbers — nothing here reaches
          Meta or the live business number.
        </p>

        <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <select
            className="input-clean"
            style={{ flex: "1 1 220px", minWidth: 0 }}
            value={identity ?? ""}
            onChange={(e) => setIdentity(e.target.value || null)}
          >
            <option value="">Me — my own account</option>
            {testUsers.map((u) => (
              <option key={u.phone} value={u.phone}>
                Test user {u.phone} {u.hasAccount ? "(signed up)" : "(not signed up yet)"}
              </option>
            ))}
          </select>
          <button className="btn-secondary" type="button" onClick={newTestUser} disabled={busy}>
            New test user
          </button>
          {identity && (
            <button className="btn-danger" type="button" onClick={deleteTestUser} disabled={busy}>
              Delete test user
            </button>
          )}
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 12 }}>
          {identity
            ? "A brand-new person — their first message starts the real signup flow."
            : "Chats as your own account, so it uses (and adds to) your real data."}{" "}
          Number: {phone ?? "…"}
        </p>

        <div className="chat-panel">
          <div className="chat-scroll" ref={scrollRef}>
            {entries.length === 0 && !waiting && (
              <p className="muted" style={{ marginBottom: 12 }}>
                Type a message below exactly as a WhatsApp user would — "hi", a question, a link, etc.
              </p>
            )}
            {entries.map((entry) => (
              <div key={entry.id} className={`chat-bubble ${entry.role}`}>
                <div style={{ whiteSpace: "pre-wrap" }}>{entry.text}</div>
                {entry.choices && entry.choices.length > 0 && (
                  <div className="chips" style={{ marginTop: 8 }}>
                    {entry.choices.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className="chip-minimal"
                        disabled={busy}
                        onClick={() => send({ buttonId: c.id, label: c.title })}
                      >
                        {c.title}
                      </button>
                    ))}
                  </div>
                )}
                {entry.link && (
                  <div style={{ marginTop: 8 }}>
                    <a href={entry.link.url} target="_blank" rel="noreferrer" className="chip-minimal">
                      {entry.link.label} ↗
                    </a>
                  </div>
                )}
                {entry.locationRequest && (
                  <div className="chips" style={{ marginTop: 8 }}>
                    <button type="button" className="chip-minimal" disabled={busy} onClick={shareLocation}>
                      📍 Send location
                    </button>
                  </div>
                )}
              </div>
            ))}
            {waiting && <div className="chat-bubble assistant muted">Typing…</div>}
            {error && <p className="error">Error: {error}</p>}
          </div>
          <div className="chat-input-row">
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                sendTyped();
              }}
            >
              <input
                className="input-clean"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Message as a WhatsApp user…"
              />
              <button className="btn-primary" type="submit" disabled={busy}>
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
