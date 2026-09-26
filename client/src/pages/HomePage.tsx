import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { motion, useScroll, useTransform, useMotionValueEvent } from "motion/react";
import { FileText, Folder, Plane } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { loginUrl } from "../api/client";
import { prefersReducedMotion } from "../lib/motionPrefs";
import { HelpWidget } from "../components/HelpWidget";
import "./home.css";

const CONTACT_EMAIL = "hello@marlowe.app";

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

/** Donut ring driving a scroll-linked stroke-dashoffset + a synced counting number, both bound
 *  directly to the same scroll-progress MotionValue slice — no separate animation timeline. */
function SchengenMeter({ progress }: { progress: import("motion/react").MotionValue<number> }) {
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const target = 61;
  const total = 90;

  const dashOffset = useTransform(progress, [0.7, 0.92], [circumference, circumference * (1 - target / total)], {
    clamp: true,
  });
  const countRaw = useTransform(progress, [0.7, 0.92], [0, target], { clamp: true });
  // Written straight to the DOM instead of through React state — a scroll-driven value changes
  // every animation frame, and routing that through setState would re-render this (and its
  // parents) 60x/sec for the whole scroll gesture. This is Motion's own recommended pattern for
  // exactly this case (see "animate a number" in their docs).
  const countRef = useRef<HTMLSpanElement>(null);
  useMotionValueEvent(countRaw, "change", (v) => {
    if (countRef.current) countRef.current.textContent = String(Math.round(v));
  });

  return (
    <div className="filmstrip-meter">
      <svg width="160" height="160" viewBox="0 0 160 160">
        <circle cx="80" cy="80" r={radius} stroke="var(--rule)" strokeWidth="10" fill="none" />
        <motion.circle
          cx="80"
          cy="80"
          r={radius}
          stroke="var(--accent)"
          strokeWidth="10"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          style={{ strokeDashoffset: dashOffset }}
        />
      </svg>
      <div className="filmstrip-meter-value">
        <span className="filmstrip-meter-count" ref={countRef}>0</span>
        <span className="filmstrip-meter-label">Days Used</span>
      </div>
    </div>
  );
}

/** "One forward, infinite recall." — a scroll-jacked horizontal filmstrip: vertical scroll
 *  through a tall pinned section drives a horizontal card track, same narrative the mockup told
 *  (a forwarded boarding pass, auto-filed, confirmed, then reflected in the Schengen tracker) but
 *  as one continuous scroll-linked animation instead of separate static sections. Falls back to a
 *  plain horizontally-scrollable, non-pinned section under prefers-reduced-motion (see home.css). */
function TravelFilmstrip() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [maxMove, setMaxMove] = useState(0);
  const [sectionHeight, setSectionHeight] = useState<number | null>(null);

  // Runs before paint (not after) so the section's scroll-jack height is correct on first frame
  // rather than jumping once measurement catches up. The section's height is derived FROM maxMove
  // (viewport + exact travel distance) rather than a fixed vh guess, so the scroll range always
  // matches the reveal exactly — no dead scroll once the last card is already fully in view, and
  // no scrolling past the whole thing before the cards have had room to move.
  useLayoutEffect(() => {
    function measure() {
      if (!trackRef.current) return;
      if (prefersReducedMotion()) {
        setMaxMove(0);
        setSectionHeight(null); // let the reduced-motion CSS's `height: auto` take over
        return;
      }
      const trackWidth = trackRef.current.scrollWidth;
      const viewport = window.innerWidth;
      const move = Math.max(0, trackWidth - viewport + 32); // 32px breathing room past the last card, not 10% of the viewport
      setMaxMove(move);
      setSectionHeight(window.innerHeight + move);
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const { scrollYProgress } = useScroll({ target: sectionRef, offset: ["start start", "end end"] });
  const x = useTransform(scrollYProgress, [0, 1], [0, -maxMove]);
  const progressWidth = useTransform(scrollYProgress, [0, 1], ["0%", "100%"]);

  return (
    <section
      className="filmstrip-section"
      ref={sectionRef}
      style={sectionHeight != null ? { height: sectionHeight } : undefined}
    >
      <div className="filmstrip-sticky">
        <div className="home-shell filmstrip-heading">
          <span className="home-eyebrow">Workflow Logic</span>
          <h2 className="home-h2">One forward, infinite recall.</h2>
        </div>

        <motion.div className="filmstrip-track home-shell" ref={trackRef} style={{ x }}>
          <article className="filmstrip-card">
            <span className="filmstrip-card-eyebrow">01 Reception</span>
            <div className="filmstrip-card-body">
              <div className="filmstrip-doc">
                <FileText size={40} />
                <div className="filmstrip-doc-name">boarding-pass.pdf</div>
                <div className="filmstrip-doc-meta">Ryanair · Faro · 12 Sept</div>
                <div className="filmstrip-doc-ref">REF: QK4T2P</div>
              </div>
            </div>
            <p className="filmstrip-card-note">
              Forward any attachment directly to your dedicated Marlowe inbox or WhatsApp thread.
            </p>
          </article>

          <article className="filmstrip-card">
            <span className="filmstrip-card-eyebrow">02 Organization</span>
            <div className="filmstrip-card-body filmstrip-folder">
              <Folder size={120} strokeWidth={1.4} />
              <div className="filmstrip-folder-plane">
                <Plane size={22} />
              </div>
              <div className="filmstrip-folder-title">Travel Documents</div>
              <div className="filmstrip-folder-sub">Auto-Sorted Folder</div>
            </div>
            <p className="filmstrip-card-note">
              Marlowe extracts data points and files the document into your linked cloud storage
              automatically.
            </p>
          </article>

          <article className="filmstrip-card">
            <span className="filmstrip-card-eyebrow">03 Confirmation</span>
            <div className="filmstrip-card-body">
              <div className="filmstrip-confirm">
                <div className="bubble bubble-marlowe">
                  Filed as Ryanair Boarding Pass, Faro — 12 Sept. Trip logged in travel log.
                </div>
                <div className="filmstrip-entry-log">&gt;&gt; ENTRY CREATED: TRIP_FARO_SEP_12</div>
              </div>
            </div>
            <p className="filmstrip-card-note">
              Immediate confirmation via chat keeps you informed of exactly where your data
              landed.
            </p>
          </article>

          <article className="filmstrip-card">
            <span className="filmstrip-card-eyebrow">04 Intelligence</span>
            <div className="filmstrip-card-body">
              <SchengenMeter progress={scrollYProgress} />
              <div className="filmstrip-folder-title" style={{ marginTop: 24 }}>
                Schengen Meter
              </div>
              <div className="filmstrip-folder-sub">Rolling 180d window</div>
            </div>
            <p className="filmstrip-card-note">
              Marlowe synthesizes your data into real-time answers for travel limits and visa
              requirements.
            </p>
          </article>
        </motion.div>

        <div className="home-shell progress-rail">
          <motion.div className="progress-bar" style={{ width: progressWidth }} />
        </div>
      </div>
    </section>
  );
}

// Sign-ins the server refused because nothing ties that provider account to the existing Marlowe
// account with the same email (server/src/routes/authRoutes.ts's resolveMicrosoftUser /
// googleMayUseExistingUser).
const SIGN_IN_ERROR_TEXT: Record<string, string> = {
  microsoft_unverified:
    "We couldn't confirm that Microsoft account belongs to the Marlowe account with that email. Sign in the way you did before, then connect Outlook from Settings.",
  google_unverified:
    "We couldn't confirm that Google account belongs to the Marlowe account with that email. Sign in the way you did before, then connect Gmail from Settings.",
};

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
              {SIGN_IN_ERROR_TEXT[error] ?? "That sign-in didn't go through. Give it another try."}
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

        <TravelFilmstrip />

        <Exchange
          flip
          eyebrow="Ask for the work"
          title="Say what you want. It goes and does it."
          body="Drafting replies, moving meetings, digging out the invoice from March. Marlowe shows you every email it writes, and only sends it once you tap Send."
          ask="Reply to Priya — Thursday works, but make it 3pm"
          reply="Here's the draft — tap Send, Edit, or Leave in Drafts."
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
                  <h3>Nothing sends without you</h3>
                  <p>
                    Marlowe shows you every email before it goes. It sends only when you tap Send —
                    otherwise it stays in your Drafts.
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

      <HelpWidget />
    </div>
  );
}
