// Ten synthetic users for the Briefing Lab (client/src/pages/BriefingLabPage.tsx), so the
// briefing's voice can be judged across setups it would otherwise take real accounts and real
// waiting to see — a quiet retiree at 9pm, a trader at 6am, a nomad with a flight in two days, a
// brand-new signup with nothing connected yet.
//
// These are fact sets, not accounts: nothing here is written to the database, no provider is
// called, and no real user's mail is involved. Every name, sender and headline below is invented.
// The point is that they run through briefing.ts's real prompt via renderBriefing, so what the lab
// shows is what a user with that shape of day would actually receive.
import { isQuietDay, renderBriefing, type BriefingDay, type BriefingVoice } from "./briefing.js";
import { senderDisplayName } from "./hub.js";
import { renderDigest, type DigestDay } from "./emailDigest.js";

export interface BriefingProfile {
  id: string;
  /** Short label for the card, e.g. "Trader, 6am, markets on". */
  label: string;
  /** One line on what this profile is meant to stress-test. */
  tests: string;
  voice: BriefingVoice;
  day: BriefingDay;
}

export interface RenderedProfile extends BriefingProfile {
  text: string;
  wordCount: number;
  quiet: boolean;
}

// Seeded so the lab is stable across reloads and a scramble is reproducible from its seed — you
// can send someone "seed 4821" and they see the same ten briefings. mulberry32: small, fast, and
// good enough for picking sample data.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length) % xs.length];
}

// `n` items drawn without replacement, so a scrambled inbox never lists the same email twice.
function sample<T>(r: () => number, xs: readonly T[], n: number): T[] {
  const pool = [...xs];
  const out: T[] = [];
  while (out.length < n && pool.length > 0) out.push(...pool.splice(Math.floor(r() * pool.length), 1));
  return out;
}

// Senders are in the `"Name" <addr>` form providers actually hand back, not bare addresses — that
// is what senderDisplayName is written for, and feeding it bare addresses made the lab render
// "m.okafor" where production would have said "Mo Okafor".
const PEOPLE_MAIL = [
  { subject: "Invoice 2291 overdue", from: '"Sarah Whitfield" <sarah@acmebooks.example>' },
  { subject: "Re: warehouse lease", from: '"Mo Okafor" <m.okafor@legalpartners.example>' },
  { subject: "Team offsite dates?", from: '"Priya Raman" <priya@company.example>' },
  { subject: "Quote for the Porto job", from: '"Tiago Sousa" <tiago@buildco.example>' },
  { subject: "Can you look at this before Friday", from: '"Dan Whitlock" <dan@studio.example>' },
  { subject: "Re: Re: the numbers don't match", from: '"Accounts (Meridian Supply)" <accounts@supplier.example>' },
  { subject: "Lunch Thursday?", from: '"Hannah Beecher" <hannah@oldfriend.example>' },
  { subject: "Draft contract attached", from: '"Whitfield & Co Legal" <legal@counterparty.example>' },
] as const;

const AUTOMATED_MAIL = [
  { subject: "Your statement is ready", from: '"Northbank" <noreply@bank.example>' },
  { subject: "Your order has shipped", from: '"Shopfront Orders" <orders@shop.example>' },
  { subject: "Subscription renews in 3 days", from: '"Ledgerly Billing" <billing@saas.example>' },
  { subject: "Weekly digest: 14 new posts", from: '"The Weekly" <digest@newsletter.example>' },
] as const;

// Events are stored as pieces, not finished strings, because each profile's "today" is a
// different weekday — a hardcoded "Wednesday 30 Sep" beside a profile whose today is Tuesday made
// the model correctly report that nothing was on today, which looked like a prompt bug and wasn't.
// dayFor composes these into the same shape describeEventTime produces for a real event.
const TODAY_EVENTS = [
  { title: "Dentist", time: "14:00" },
  { title: "Call with Priya", time: "16:30" },
  { title: "Standup", time: "09:15" },
  { title: "Site visit", time: "11:00" },
  { title: "Board prep", time: "08:00" },
  { title: "School pickup", time: "15:30" },
  { title: "Physio", allDay: true },
] as const;

// `offset` is days from today, so an upcoming event never lands on today's weekday.
const UPCOMING_EVENTS = [
  { title: "Flight to Amsterdam KL 1014", time: "19:15", offset: 2 },
  { title: "Checkout from Casa Boa", time: "11:00", offset: 2 },
  { title: "Train to Porto", time: "07:40", offset: 1 },
  { title: "Quarterly review", time: "10:00", offset: 2 },
  { title: "Dinner with the Alvarezes", time: "20:00", offset: 1 },
  { title: "Car service", allDay: true, offset: 3 },
] as const;

const HEADLINES = [
  { topic: "business", title: "Central bank holds rates for a third meeting" },
  { topic: "technology", title: "Chipmaker warns of tighter supply into next year" },
  { topic: "world", title: "Coalition talks enter a second week" },
  { topic: "business", title: "Freight rates fall back to pre-summer levels" },
  { topic: "technology", title: "Regulator opens consultation on data portability" },
] as const;

const CONDITIONS = ["light rain", "clear", "overcast", "patchy cloud", "heavy showers"] as const;

function weatherFor(r: () => number, place: string): BriefingDay["weather"] {
  const tempC = 6 + Math.floor(r() * 24);
  return { place, condition: pick(r, CONDITIONS), tempC, highC: tempC + 2 + Math.floor(r() * 4), lowC: tempC - 3 - Math.floor(r() * 3) };
}

function quotesFor(r: () => number): BriefingDay["quotes"] {
  const named = [
    { symbol: "^GSPC", name: "S&P 500" },
    { symbol: "^IXIC", name: "Nasdaq" },
    { symbol: "BTC-USD", name: "Bitcoin" },
  ];
  return named.map((q) => {
    const price = Number((100 + r() * 4000).toFixed(2));
    const changePercent = Number((r() * 4 - 2).toFixed(2));
    return {
      ...q,
      price,
      changePercent,
      change: Number(((price * changePercent) / 100).toFixed(2)),
      currency: "USD",
    };
  });
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

// Matches describeEventTime's output format, so what the lab feeds the prompt is indistinguishable
// in shape from what a real calendar produces. The date is nominal — these users aren't real and
// the model only ever needs the weekday and the clock time.
function eventLine(e: { title: string; time?: string; allDay?: boolean }, weekdayIndex: number, dayOfMonth: number): string {
  const day = `${WEEKDAYS[((weekdayIndex % 7) + 7) % 7]} ${dayOfMonth} Oct`;
  return e.allDay ? `${e.title} (all day, ${day})` : `${e.title} at ${e.time} on ${day}`;
}

// A profile is a shape, not a fixed day: each one says how much of each kind of thing it has, and
// the actual items are drawn from the pools above. That's what makes Scramble show genuine variety
// rather than the same ten briefings with the numbers nudged.
interface ProfileShape {
  id: string;
  label: string;
  tests: string;
  voice: BriefingVoice;
  /** Plausible send times for this person, one picked per scramble. */
  times: readonly string[];
  unread: readonly number[];
  todayEvents: readonly number[];
  upcoming: readonly number[];
  flagged: readonly number[];
  location?: string;
  weatherPlace?: string;
  markets?: boolean;
  news?: boolean;
  /** Include automated mail among the unread, for profiles where the inbox is mostly noise. */
  noisyInbox?: boolean;
  /**
   * An upcoming event this profile always gets, whatever the seed. Used where the profile exists
   * to test a specific case — the nomad's whole job is "quiet day, but there's a flight", which a
   * random draw from the pool would lose on most seeds.
   */
  alwaysUpcoming?: string;
  /**
   * Real-person emails held for the evening recap. Independent of `unread`, which is
   * unread-since-midnight — a day can end with a full recap queue and an empty inbox badge.
   * A shape with only 0 here is showing the case where no recap is sent at all, which is correct
   * behaviour and worth being able to see.
   */
  digest: readonly number[];
  /** When the recap goes out, in their own local time. */
  digestTimes: readonly string[];
}

const SHAPES: readonly ProfileShape[] = [
  {
    id: "founder",
    label: "Founder, travelling, everything on",
    tests: "The densest possible day — does it still choose, or try to mention all of it?",
    voice: { assistantName: "Marlo", userName: "Jake", persona: "I run three businesses. Be brief and direct. Flag anything from my accountant as urgent." },
    times: ["06:45", "07:30", "08:00"],
    unread: [4, 6, 9],
    todayEvents: [2, 3],
    upcoming: [2],
    flagged: [1, 2],
    location: "Currently in Lisbon, Portugal — arrived 4 days ago, been there 4 days.",
    weatherPlace: "Lisbon",
    markets: true,
    news: true,
    noisyInbox: true,
    digest: [5, 8],
    digestTimes: ["21:00", "22:00"],
  },
  {
    id: "retiree",
    label: "Retiree, 9pm send, weather only",
    tests: "The quiet-day check-in, in the evening — does it land warm and say 'sleep well'?",
    voice: { assistantName: "Marlo", userName: "Margaret", persona: "" },
    times: ["20:30", "21:00"],
    unread: [0],
    todayEvents: [0],
    upcoming: [0, 1],
    flagged: [0],
    weatherPlace: "Bristol",
    digest: [1, 2],
    digestTimes: ["20:00", "21:00"],
  },
  {
    id: "nomad",
    label: "Nomad, flight in two days, no feeds",
    tests: "A quiet day that still has a flight to pack for — does the flight survive the quiet branch?",
    voice: { assistantName: "Marlo", userName: "Ines", persona: "Keep it casual. I'm usually between places." },
    times: ["07:00", "09:15"],
    // Deliberately always quiet with something upcoming: this is the one profile covering "quiet
    // day, but there's still a flight to pack for", which the prompt has to handle without either
    // listing emptiness or dropping the flight. Letting it have unread mail on some seeds would
    // silently lose that coverage — see briefingPreview.test.ts.
    unread: [0],
    todayEvents: [0],
    upcoming: [2],
    flagged: [0],
    alwaysUpcoming: "Flight to Amsterdam KL 1014",
    location: "Currently in Tbilisi, Georgia — arrived 11 days ago, been there 11 days.",
    digest: [1, 3],
    digestTimes: ["18:30", "21:00"],
  },
  {
    id: "exec",
    label: "Executive, packed diary, markets on",
    tests: "Lots of calendar and a backlog of replies — does it lead with the right one?",
    voice: { assistantName: "Marlo", userName: "Daniel", persona: "Very short. Bullet-free. Assume I'm reading this walking to a meeting." },
    times: ["06:15", "06:30"],
    unread: [5, 8],
    todayEvents: [3],
    upcoming: [1, 2],
    flagged: [2, 3],
    markets: true,
    digest: [6, 9],
    digestTimes: ["21:00"],
  },
  {
    id: "freelancer",
    label: "Freelancer, no calendar, news on",
    tests: "Mail but no events — does it avoid saying 'nothing scheduled' as a line of its own?",
    voice: { assistantName: "Marlo", userName: "Tom", persona: "" },
    times: ["08:30", "09:00"],
    unread: [2, 3],
    todayEvents: [0],
    upcoming: [0],
    flagged: [1],
    news: true,
    digest: [2, 3],
    digestTimes: ["18:30", "20:00"],
  },
  {
    id: "newuser",
    label: "Brand-new signup, nothing set up",
    tests: "No name, no feeds, nothing connected — the worst case for sounding robotic.",
    voice: { assistantName: "Marlo", userName: "", persona: "" },
    times: ["07:30"],
    unread: [0],
    todayEvents: [0],
    upcoming: [0],
    flagged: [0],
    digest: [0],
    digestTimes: ["21:00"],
  },
  {
    id: "nightshift",
    label: "Night shift, 10pm send",
    tests:
      "An off-hours send time (recap at 06:30) plus a persona saying mornings are wrong for them — " +
      "evening framing is correct here; what must not appear is \"sleep well\" as they start their day.",
    voice: { assistantName: "Marlo", userName: "Kemi", persona: "I work nights, so 'morning' is wrong for me." },
    times: ["22:00", "22:30"],
    unread: [2, 4],
    todayEvents: [1, 2],
    upcoming: [1],
    flagged: [0, 1],
    weatherPlace: "Cape Town",
    digest: [2, 4],
    digestTimes: ["06:30"],
  },
  {
    id: "parent",
    label: "Parent, all-day school events",
    tests: "All-day events mixed with timed ones — do they read naturally in prose?",
    voice: { assistantName: "Marlo", userName: "Rachel", persona: "Family stuff first, work second." },
    times: ["06:50", "07:15"],
    unread: [1, 3],
    todayEvents: [2, 3],
    upcoming: [1],
    flagged: [0],
    weatherPlace: "Bristol",
    noisyInbox: true,
    digest: [3, 5],
    digestTimes: ["20:00", "21:00"],
  },
  {
    id: "trader",
    label: "Trader, 6am, markets-heavy",
    tests: "Markets on with a thin day otherwise — does the opt-in feed take over the message?",
    voice: { assistantName: "Marlo", userName: "Viktor", persona: "Numbers first. I don't need pleasantries." },
    times: ["05:45", "06:00"],
    unread: [1, 2],
    todayEvents: [0, 1],
    upcoming: [0],
    flagged: [0],
    markets: true,
    news: true,
    digest: [1, 2],
    digestTimes: ["18:30"],
  },
  {
    id: "minimalist",
    label: "Minimalist, everything off, quiet",
    tests: "The absolute minimum — one or two sentences, and it must not feel like an error.",
    voice: { assistantName: "Marlo", userName: "Sam", persona: "Say as little as possible." },
    times: ["07:30", "12:00"],
    unread: [0],
    todayEvents: [0],
    upcoming: [0],
    flagged: [0],
    digest: [0],
    digestTimes: ["21:00"],
  },
];

function dayFor(shape: ProfileShape, r: () => number): BriefingDay {
  const unreadCount = pick(r, shape.unread);
  const pool = shape.noisyInbox ? [...PEOPLE_MAIL, ...AUTOMATED_MAIL] : PEOPLE_MAIL;
  // senderDisplayName, exactly as buildBriefingText does — the lab must not feed the prompt
  // tidier senders than production would.
  const shown = sample(r, pool, unreadCount).map((m) => ({ subject: m.subject, from: senderDisplayName(m.from) }));
  // One weekday for the whole profile, so "today" and the next three days are consistent with
  // each other and with the greeting the prompt is asked to pitch at localTime.
  const weekdayIndex = Math.floor(r() * 7);
  const dayOfMonth = 1 + Math.floor(r() * 25);

  const upcomingPool = shape.alwaysUpcoming
    ? UPCOMING_EVENTS.filter((e) => e.title !== shape.alwaysUpcoming)
    : UPCOMING_EVENTS;
  const forced = shape.alwaysUpcoming
    ? UPCOMING_EVENTS.filter((e) => e.title === shape.alwaysUpcoming)
    : [];
  const drawn = sample(r, upcomingPool, Math.max(0, pick(r, shape.upcoming) - forced.length));

  return {
    localTime: pick(r, shape.times),
    localWeekday: WEEKDAYS[weekdayIndex],
    location: shape.location ?? "",
    weather: shape.weatherPlace ? weatherFor(r, shape.weatherPlace) : null,
    quotes: shape.markets ? quotesFor(r) : [],
    unread: { count: unreadCount, shown },
    todayEvents: sample(r, TODAY_EVENTS, pick(r, shape.todayEvents)).map((e) =>
      eventLine(e, weekdayIndex, dayOfMonth)
    ),
    upcomingEvents: [...forced, ...drawn].map((e) =>
      eventLine(e, weekdayIndex + e.offset, dayOfMonth + e.offset)
    ),
    flagged: sample(r, PEOPLE_MAIL, pick(r, shape.flagged)).map((m) => ({
      subject: m.subject,
      from: senderDisplayName(m.from),
    })),
    news: shape.news ? sample(r, HEADLINES, 3).map((h) => ({ topic: h.topic, title: h.title })) : [],
  };
}

// The evening recap's facts for a profile. Senders come from PEOPLE_MAIL only, never
// AUTOMATED_MAIL: the recap is real-person mail by definition, and automated mail is routed to the
// instant important-email alerts instead — it can never appear here, so neither can it here.
//
// Some senders get a count above 1, which is what exercises the thread-grouping line ("and 2 more
// on the same thread") the model needs in order to say "Jake's come back a few times".
function digestDayFor(shape: ProfileShape, r: () => number): DigestDay | null {
  const people = pick(r, shape.digest);
  if (people === 0) return null;
  const senders = sample(r, PEOPLE_MAIL, people).map((m) => ({
    name: senderDisplayName(m.from),
    subject: m.subject,
    // Roughly a third of threads get a reply or two on top, so grouping is usually in play.
    count: r() < 0.33 ? 2 + Math.floor(r() * 2) : 1,
  }));
  return {
    localTime: pick(r, shape.digestTimes),
    localWeekday: WEEKDAYS[Math.floor(r() * 7)],
    total: senders.reduce((sum, g) => sum + g.count, 0),
    senders,
  };
}

export interface DigestProfile {
  id: string;
  label: string;
  tests: string;
  voice: BriefingVoice;
  /** null when this profile has nothing held, i.e. no recap is sent — correct, and worth seeing. */
  day: DigestDay | null;
}

export interface RenderedDigest extends DigestProfile {
  /** "" when day is null: nothing is sent. */
  text: string;
  wordCount: number;
}

export function buildDigestProfiles(seed = DEFAULT_SEED): DigestProfile[] {
  return SHAPES.map((shape, i) => {
    // A different multiplier from buildProfiles, so a profile's recap isn't drawn from the same
    // rolls as its morning briefing and the two don't move in lockstep when you scramble.
    const r = rng(seed * 6271 + i * 92831);
    return { id: shape.id, label: shape.label, tests: shape.tests, voice: shape.voice, day: digestDayFor(shape, r) };
  });
}

export async function renderDigests(ownerId: number, seed: number): Promise<RenderedDigest[]> {
  return Promise.all(
    buildDigestProfiles(seed).map(async (p) => {
      if (!p.day) return { ...p, text: "", wordCount: 0 };
      const text = (await renderDigest(ownerId, p.voice, p.day, "briefing_lab")).trim();
      return { ...p, text, wordCount: text.split(/\s+/).filter(Boolean).length };
    })
  );
}

// The default seed. Any other seed is a scramble; the same seed always gives the same ten days.
export const DEFAULT_SEED = 1;

export function buildProfiles(seed = DEFAULT_SEED): BriefingProfile[] {
  // One generator per profile, seeded from the page seed and the profile's index, so scrambling
  // re-rolls every card rather than shifting them all along by one.
  return SHAPES.map((shape, i) => {
    const r = rng(seed * 7919 + i * 104729);
    return { id: shape.id, label: shape.label, tests: shape.tests, voice: shape.voice, day: dayFor(shape, r) };
  });
}

export function newSeed(): number {
  return 1 + Math.floor(Math.random() * 9998);
}

// Renders every profile through the real briefing prompt, in parallel. Usage is recorded against
// the admin who asked, under its own purpose, so lab spend shows up separately from real
// briefings in the portal's API-usage breakdown.
export async function renderProfiles(ownerId: number, seed: number): Promise<RenderedProfile[]> {
  const profiles = buildProfiles(seed);
  return Promise.all(
    profiles.map(async (p) => {
      const text = (await renderBriefing(ownerId, p.voice, p.day, "briefing_lab")).trim();
      return { ...p, text, wordCount: text.split(/\s+/).filter(Boolean).length, quiet: isQuietDay(p.day) };
    })
  );
}
