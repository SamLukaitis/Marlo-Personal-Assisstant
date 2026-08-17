import { useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { loginUrl } from "../api/client";
import "./home.css";

const CONTACT_EMAIL = "hello@marlowe.app";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** Adds `is-visible` the first time an element scrolls into view, and then stops watching. */
function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.18, rootMargin: "0px 0px -60px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, className: `reveal${visible ? " is-visible" : ""}` };
}

function Reveal({ children, as: Tag = "div", extra = "" }: { children: ReactNode; as?: "div" | "section"; extra?: string }) {
  const { ref, className } = useReveal<HTMLDivElement>();
  return (
    <Tag ref={ref as never} className={`${className} ${extra}`.trim()}>
      {children}
    </Tag>
  );
}

/** Types a message out character by character, then hands off to the reply. */
function useTypewriter(text: string, active: boolean) {
  const [shown, setShown] = useState(active ? "" : text);
  const [done, setDone] = useState(!active);

  useEffect(() => {
    if (!active) return;
    if (prefersReducedMotion()) {
      setShown(text);
      setDone(true);
      return;
    }
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      setShown(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(timer);
        setDone(true);
      }
    }, 38);
    return () => clearInterval(timer);
  }, [text, active]);

  return { shown, done };
}

function HeroThread() {
  const { shown, done } = useTypewriter("What does my day look like?", true);
  const [replying, setReplying] = useState(false);
  const [answered, setAnswered] = useState(false);

  useEffect(() => {
    if (!done) return;
    const a = setTimeout(() => setReplying(true), 350);
    const b = setTimeout(() => {
      setReplying(false);
      setAnswered(true);
    }, 1700);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [done]);

  return (
    <div className="thread">
      <div className="thread-head">
        <span className="thread-head-dot" />
        Marlowe · WhatsApp
      </div>

      <div className="bubble bubble-user">
        {shown}
        {!done && <span className="caret" />}
      </div>

      {replying && (
        <div className="typing" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      )}

      {answered && (
        <>
          <div className="bubble bubble-marlowe">Here's the shape of it.</div>
          <div className="result-card is-visible">
            <div className="result-card-head">Thursday, 17 April</div>
            <div className="result-row">
              <span className="result-row-key">Unread</span>
              <span className="result-row-value">4 — two need a reply</span>
            </div>
            <div className="result-row">
              <span className="result-row-key">First up</span>
              <span className="result-row-value">09:30 Design review</span>
            </div>
            <div className="result-row">
              <span className="result-row-key">Outside</span>
              <span className="result-row-value">14°C, overcast</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface ExchangeProps {
  eyebrow: string;
  title: string;
  body: string;
  ask: string;
  reply: string;
  card?: ReactNode;
  flip?: boolean;
}

function Exchange({ eyebrow, title, body, ask, reply, card, flip }: ExchangeProps) {
  const { ref, className } = useReveal<HTMLDivElement>();

  return (
    <section className="home-section">
      <div className="home-shell">
        <div ref={ref} className={`exchange${flip ? " flip" : ""} ${className}`}>
          <div className="exchange-copy">
            <span className="home-eyebrow">{eyebrow}</span>
            <h2 className="home-h2">{title}</h2>
            <p className="home-lede">{body}</p>
          </div>
          <div className="thread">
            <div className="bubble bubble-user">{ask}</div>
            <div className="bubble bubble-marlowe">{reply}</div>
            {card}
          </div>
        </div>
      </div>
    </section>
  );
}

export function HomePage() {
  const { user, loading, refresh } = useAuth();
  const [params] = useSearchParams();
  const [scrolled, setScrolled] = useState(false);
  const notInvited = params.get("not_invited") === "1";
  const error = params.get("error");

  // Coming back from a failed/rejected OAuth attempt shouldn't leave stale "loading" state —
  // re-check auth once in case something did change (e.g. a second tab already logged in).
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (loading) return null;
  if (user) return <Navigate to="/assistant" replace />;

  const google = loginUrl("/auth/google/login-signin");
  const microsoft = loginUrl("/auth/microsoft/login-signin");

  return (
    <div className="home">
      <header className={`home-topbar${scrolled ? " scrolled" : ""}`}>
        <div className="home-shell home-topbar-inner">
          <span className="home-wordmark">
            <span className="home-mark">M</span>
            Marlowe
          </span>
          <div className="home-topbar-actions">
            <a href={microsoft} className="home-btn home-btn-quiet">
              Sign in
            </a>
            <a href={google} className="home-btn home-btn-primary">
              Get started
            </a>
          </div>
        </div>
      </header>

      <main>
        <div className="home-shell">
          {notInvited && (
            <div className="home-banner warn" style={{ marginTop: 24 }}>
              That account isn't on the invite list yet. Marlowe is in a closed preview — ask
              whoever invited you to add your email address.
            </div>
          )}
          {error && !notInvited && (
            <div className="home-banner warn" style={{ marginTop: 24 }}>
              That sign-in didn't go through. Give it another try.
            </div>
          )}

          <section className="home-hero">
            <div>
              <h1 className="home-h1">
                The assistant you can just <em>text</em>.
              </h1>
              <p className="home-hero-sub">
                Marlowe reads your mail, watches your calendar, files whatever you send it, and
                answers on WhatsApp. One conversation instead of six apps.
              </p>
              <div className="home-hero-actions">
                <a href={google} className="home-btn home-btn-primary">
                  Continue with Google
                </a>
                <a href={microsoft} className="home-btn home-btn-ghost">
                  Continue with Microsoft
                </a>
              </div>
              <p className="home-hero-note">Closed preview · invitation required</p>
            </div>
            <div className="home-hero-thread">
              <HeroThread />
            </div>
          </section>
        </div>

        <section className="home-section">
          <div className="home-shell">
            <Reveal>
              <span className="home-eyebrow">What it works from</span>
              <h2 className="home-h2">It reads what you already have.</h2>
              <p className="home-lede">
                Connect the accounts you actually use. Marlowe works across all of them at once, so
                you stop remembering which inbox a thing landed in.
              </p>
              <div className="connector-grid">
                {["Gmail", "Outlook", "Google Calendar", "Google Drive", "OneDrive", "Teams"].map(
                  (name) => (
                    <div key={name} className="connector-cell">
                      {name}
                    </div>
                  )
                )}
              </div>
            </Reveal>
          </div>
        </section>

        <Exchange
          eyebrow="Send it anything"
          title="Forward a document. Forget about it."
          body="Photograph a boarding pass, a receipt, a licence — anything. Marlowe reads it, names it, and files it, so months later you can just ask what was on it."
          ask="📎 boarding-pass.pdf"
          reply="Filed as Ryanair Boarding Pass, Faro — 12 Sept, 14:05. I've logged the trip too."
          card={
            <div className="result-card">
              <div className="result-card-head">Saved to your files</div>
              <div className="result-row">
                <span className="result-row-key">Document</span>
                <span className="result-row-value">Ryanair Boarding Pass, Faro</span>
              </div>
              <div className="result-row">
                <span className="result-row-key">Reference</span>
                <span className="result-row-value">QK4T2P</span>
              </div>
            </div>
          }
        />

        <Exchange
          flip
          eyebrow="Ask for the work"
          title="Say what you want. It goes and does it."
          body="Drafting replies, moving meetings, digging out the invoice from March. Marlowe writes drafts into your own mailbox for you to send — it never sends mail as you."
          ask="Reply to Priya — Thursday works, but make it 3pm"
          reply="Draft's sitting in your Gmail, ready for you to look over and send."
        />

        <section className="home-section">
          <div className="home-shell">
            <Reveal>
              <span className="home-eyebrow">Built around you</span>
              <h2 className="home-h2">Your hub only has what you asked for.</h2>
              <p className="home-lede">
                Pick your tools when you sign up. Whatever you skip never appears — no dead tabs
                for features you don't use, no settings for accounts you never connected.
              </p>
              <div className="tool-grid">
                <div className="tool-card">
                  <span className="tool-card-tag">Always on</span>
                  <h3>Mail, calendar, files</h3>
                  <p>
                    The core of it. Search across every account you've connected, and ask in plain
                    language rather than remembering where things live.
                  </p>
                </div>
                <div className="tool-card">
                  <span className="tool-card-tag">Optional</span>
                  <h3>Teams chat</h3>
                  <p>
                    Bring work conversations in alongside your mail. Skip it and Marlowe never
                    mentions Teams again.
                  </p>
                </div>
                <div className="tool-card">
                  <span className="tool-card-tag">Optional</span>
                  <h3>Travel tracker</h3>
                  <p>
                    Counts your days against the Schengen 90/180 rule automatically, using the
                    tickets you already forwarded.
                  </p>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        <Exchange
          eyebrow="It keeps count"
          title="The answer to questions you'd have to work out."
          body="Because Marlowe files your tickets as they arrive, it already knows where you've been. Day counts, limits, and how close you are to them."
          ask="How many days have I got left in the EU?"
          reply="29. You've used 61 of your 90 across the last 180 days."
          card={
            <div className="result-card">
              <div className="result-card-head">Schengen, rolling 180 days</div>
              <div className="result-meter">
                <div className="result-meter-track">
                  <div className="result-meter-fill" style={{ ["--fill" as string]: "68%" }} />
                </div>
                <span className="result-meter-label">61 of 90 days used · 29 remaining</span>
              </div>
            </div>
          }
        />

        <section className="home-section">
          <div className="home-shell">
            <Reveal>
              <span className="home-eyebrow">Where you stand</span>
              <h2 className="home-h2">Your accounts. Your data. Your assistant.</h2>
              <ul className="trust-list">
                <li>
                  <h3>Nothing is shared</h3>
                  <p>
                    Every hub is separate. Your mail, files, and documents are reachable only by
                    your own assistant, never by anyone else's.
                  </p>
                </li>
                <li>
                  <h3>It can't send mail as you</h3>
                  <p>
                    Marlowe writes drafts into your mailbox and stops there. You read them and you
                    press send.
                  </p>
                </li>
                <li>
                  <h3>Disconnect whenever</h3>
                  <p>
                    Remove an account and its access goes with it. Delete a saved document and it's
                    gone from storage.
                  </p>
                </li>
              </ul>
            </Reveal>
          </div>
        </section>

        <div className="home-shell">
          <Reveal extra="home-cta">
            <h2>Stop keeping it all in your head.</h2>
            <p>
              Marlowe is in a closed preview while we work with early testers. If you've been
              invited, this is where you start.
            </p>
            <div className="home-cta-actions">
              <a href={google} className="home-btn home-btn-primary">
                Continue with Google
              </a>
              <a href={microsoft} className="home-btn home-btn-ghost">
                Continue with Microsoft
              </a>
            </div>
          </Reveal>
        </div>
      </main>

      <footer className="home-footer">
        <div className="home-shell">
          <div className="home-footer-grid">
            <div className="home-footer-brand">
              <span className="home-wordmark">
                <span className="home-mark">M</span>
                Marlowe
              </span>
              <p>A personal assistant that works across the accounts you already have.</p>
            </div>

            <div>
              <h4>Product</h4>
              <ul>
                <li><a href="#top">How it works</a></li>
                <li><a href={google}>Sign in</a></li>
                <li><a href={`mailto:${CONTACT_EMAIL}?subject=Marlowe%20preview%20access`}>Request access</a></li>
              </ul>
            </div>

            <div>
              <h4>Support</h4>
              <ul>
                <li><a href={`mailto:${CONTACT_EMAIL}?subject=Marlowe%20help`}>Help</a></li>
                <li><a href={`mailto:${CONTACT_EMAIL}?subject=Marlowe%20feedback`}>Send feedback</a></li>
                <li><a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></li>
              </ul>
            </div>

            <div>
              <h4>Elsewhere</h4>
              <ul>
                <li><a href="https://x.com" target="_blank" rel="noreferrer">X</a></li>
                <li><a href="https://www.linkedin.com" target="_blank" rel="noreferrer">LinkedIn</a></li>
                <li><a href="https://github.com" target="_blank" rel="noreferrer">GitHub</a></li>
              </ul>
            </div>
          </div>

          <div className="home-footer-base">
            <span>© {new Date().getFullYear()} Marlowe</span>
            <span>Privacy · Terms · Closed preview</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
