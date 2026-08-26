// Deterministic grading for the grounding eval (server/src/eval/*.eval.ts). No model calls here
// — everything is a regex-extract-and-diff against fixture ground truth, on purpose (see
// docs/superpowers/specs, "hallucination/grounding eval" design: deterministic-only for v1, an
// LLM-judge pass is a possible later addition for looser/semantic claims this can't catch).

// Two uppercase letters + 2-4 digits (e.g. "DL1234"). Excludes shorter forms like "AA1" —
// mirrors the minimum-length guard in reconciliation.ts's matchTier, which exists for the same
// reason: below this length, false-positive matches against incidental text become likely.
const FLIGHT_NUMBER_RE = /\b[A-Z]{2}\d{2,4}\b/g;

// 5-7 alphanumeric characters containing at least one letter and at least one digit — a plain
// English word (all letters) or a plain number (all digits) doesn't count as a reference code.
const REFERENCE_CODE_RE = /\b(?=[A-Z0-9]{5,7}\b)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*[0-9])[A-Z0-9]{5,7}\b/g;

// Models sometimes render date separators with a non-ASCII dash instead of a plain hyphen (e.g.
// U+2011 "non-breaking hyphen": "2026‑09‑12"). Normalize before any date regex runs so these
// aren't silently treated as missing.
function normalizeDashes(text: string): string {
  return text.replace(/[‐‑‒–—]/g, "-");
}

const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;

// $ or £ followed by a number, tolerating thousands separators and a stray space after the
// symbol ("£ 120.00"). USD/GBP only — good enough for fixture invoices; extend if a fixture
// ever needs another currency.
const AMOUNT_RE = /[$£]\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g;

const MONTH_NAMES: Record<string, string> = {
  jan: "01", january: "01",
  feb: "02", february: "02",
  mar: "03", march: "03",
  apr: "04", april: "04",
  may: "05",
  jun: "06", june: "06",
  jul: "07", july: "07",
  aug: "08", august: "08",
  sep: "09", sept: "09", september: "09",
  oct: "10", october: "10",
  nov: "11", november: "11",
  dec: "12", december: "12",
};
const MONTH_WORD = Object.keys(MONTH_NAMES).sort((a, b) => b.length - a.length).join("|");

// "September 12, 2026" / "Sep 12 2026"
const PROSE_DATE_MD_RE = new RegExp(`\\b(${MONTH_WORD})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "gi");
// "12 September 2026"
const PROSE_DATE_DM_RE = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_WORD})\\.?,?\\s+(\\d{4})\\b`, "gi");

function pad2(n: string): string {
  return n.padStart(2, "0");
}

// Multi-word phrases only (never a bare "no") — a bare "no" appears constantly in ordinary
// replies ("no rush", "no problem") without asserting anything is missing. Each of these commits
// to an absence claim specifically.
const DENIAL_PATTERNS: RegExp[] = [
  /\bi don't see (any|a)\b/i,
  /\bi couldn't find\b/i,
  /\bi can't find\b/i,
  /\bno record of\b/i,
  /\bnothing on file\b/i,
  /\bno booking (on file|found)\b/i,
  /\bno emails? (about|regarding|on file)\b/i,
  /\bdoesn't (appear to )?exist\b/i,
  /\bdoes not (appear to )?exist\b/i,
  // Deliberately no bare "there's no <anything>" pattern — real replies use that construction
  // constantly for true, harmless side remarks unrelated to the fact being asked about (e.g.
  // "there's no matching booking record saved yet for it" right after correctly stating the
  // flight change itself). A denial claim needs to be specific enough to name what's missing.
  /\bi don't have (any|a) record\b/i,
  /\bnot on (your|the) calendar\b/i,
  /\bno upcoming\b/i,
  /\bcalendar (is|looks) empty\b/i,
];

function extractAll(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[0].toUpperCase());
}

export function extractFlightNumbers(text: string): string[] {
  return extractAll(text, FLIGHT_NUMBER_RE);
}

export function extractReferenceCodes(text: string): string[] {
  return extractAll(text, REFERENCE_CODE_RE);
}

export function extractAmounts(text: string): string[] {
  // Strip the stray space some replies put after the symbol ("£ 120.00") so it matches the
  // fixture's canonical form ("£120.00") on a plain substring/equality check.
  return extractAll(text, AMOUNT_RE).map((v) => v.replace(/\s+/g, ""));
}

// Reverse of MONTH_NAMES — e.g. "09" -> ["sep", "sept", "september"] — so every alias
// extractDates recognizes (including informal ones like "Sept") also works here, instead of
// maintaining a second, easy-to-drift-out-of-sync month/alias list.
const MONTH_NUM_TO_NAMES: Record<string, string[]> = {};
for (const [name, num] of Object.entries(MONTH_NAMES)) {
  (MONTH_NUM_TO_NAMES[num] ??= []).push(name);
}

// Any of the dash characters a model might use in a date range ("15-18", "15–18", "15—18").
const DASH = "[-–—]";

// Checks whether one specific expected date is stated in the reply, tolerating the forms a model
// actually writes in prose that extractDates' normalize-and-collect can't cover:
//   - an ordinal suffix on the day ("October 3rd, 2026")
//   - the year dropped entirely once it's already established in conversation ("Sep 5, 9:00 AM")
//   - the day written as either end of a range ("15–18 Jan 2027", "Jan 15-18, 2027") — a
//     check-in date is very often relayed alongside a check-out date this way, and both ends of
//     a range are equally real dates, so either one can satisfy an expected date that matches it.
// A year IS required to match if the reply states one — "September 5, 2027" must not satisfy
// "2026-09-05" just because the month/day happen to line up.
export function dateAppearsInReply(iso: string, reply: string): boolean {
  reply = normalizeDashes(reply);
  if (extractDates(reply).includes(iso)) return true;

  const [year, month, dayStr] = iso.split("-");
  const names = MONTH_NUM_TO_NAMES[month];
  if (!names) return false;
  const day = String(Number(dayStr));

  const monthAlt = `(?:${names.join("|")})\\.?`;
  const dayAlt = `0?${day}`;
  // The target day, optionally preceded by "<other day>-" (it's the range's end) and/or
  // followed by "-<other day>" (it's the range's start).
  const dayInRange = `(?:\\d{1,2}\\s*${DASH}\\s*)?${dayAlt}(?:\\s*${DASH}\\s*\\d{1,2})?`;
  const monthDayRe = new RegExp(`\\b${monthAlt}\\s+${dayInRange}(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi");
  const dayMonthRe = new RegExp(`\\b${dayInRange}(?:st|nd|rd|th)?\\s+${monthAlt}(?:,?\\s+(\\d{4}))?\\b`, "gi");

  for (const re of [monthDayRe, dayMonthRe]) {
    for (const m of reply.matchAll(re)) {
      const capturedYear = m[1];
      if (!capturedYear || capturedYear === year) return true;
    }
  }
  return false;
}

export function extractDates(text: string): string[] {
  text = normalizeDashes(text);
  const iso = extractAll(text, ISO_DATE_RE);

  const mdMatches = [...text.matchAll(PROSE_DATE_MD_RE)].map(
    (m) => `${m[3]}-${MONTH_NAMES[m[1].toLowerCase()]}-${pad2(m[2])}`
  );
  const dmMatches = [...text.matchAll(PROSE_DATE_DM_RE)].map(
    (m) => `${m[3]}-${MONTH_NAMES[m[2].toLowerCase()]}-${pad2(m[1])}`
  );

  return [...new Set([...iso, ...mdMatches, ...dmMatches])];
}

export function containsDenial(text: string): boolean {
  return DENIAL_PATTERNS.some((re) => re.test(text));
}

export interface GroundTruth {
  flightNumbers?: string[];
  referenceCodes?: string[];
  dates?: string[];
  amounts?: string[];
}

export interface GradeResult {
  pass: boolean;
  missingFacts: string[];
  deniedFacts: boolean;
  inventedIdentifiers: string[];
  reasons: string[];
}

export function gradeReply(groundTruth: GroundTruth, reply: string): GradeResult {
  // Flight numbers, reference codes, and amounts are opaque tokens — the model must reproduce
  // them verbatim, so a plain substring check is exactly right. Dates get written in many
  // equally valid prose forms ("2026-09-12" vs "September 12, 2026"), so those are compared
  // against dateAppearsInReply instead of a literal substring match.
  const identifiers = [
    ...(groundTruth.flightNumbers ?? []),
    ...(groundTruth.referenceCodes ?? []),
    ...(groundTruth.amounts ?? []),
  ].map((v) => v.toUpperCase());
  const expectedDates = groundTruth.dates ?? [];

  const expected = [...identifiers, ...expectedDates];
  const missingFacts = [
    ...identifiers.filter((v) => !reply.toUpperCase().includes(v)),
    ...expectedDates.filter((d) => !dateAppearsInReply(d, reply)),
  ];

  // A denial ("I don't see any booking on file") is only a grounding failure when there was
  // something to deny AND the reply doesn't actually state it. For a negative-control fixture
  // (empty ground truth, nothing seeded in the mocked email/calendar), a denial is the *correct*
  // answer — see report.ts/fixtures.ts for the "no-such-booking" fixture this exists for. And a
  // denial phrase can legitimately be a harmless aside about something *other* than the queried
  // fact ("I don't see any OTHER trip changes") right after correctly stating that fact — found by
  // the grounding eval failing an otherwise fully-grounded reply on exactly this pattern. So only
  // treat a denial as a real failure when the expected facts are also missing from the reply.
  const hasExpectedFacts = expected.length > 0;
  const deniedFacts = containsDenial(reply);
  const failsForDenial = deniedFacts && hasExpectedFacts && missingFacts.length > 0;

  const foundFlights = extractFlightNumbers(reply);
  const foundCodes = extractReferenceCodes(reply);
  const foundAmounts = extractAmounts(reply).map((v) => v.toUpperCase());
  // A flight number like "DL1234" also matches the reference-code shape, so dedupe before
  // reporting — otherwise one invented token gets listed twice under two different extractors.
  const inventedIdentifiers = [...new Set([...foundFlights, ...foundCodes, ...foundAmounts])].filter(
    (v) => !expected.includes(v)
  );

  const reasons: string[] = [];
  if (missingFacts.length) reasons.push(`missing expected fact(s): ${missingFacts.join(", ")}`);
  if (failsForDenial) reasons.push("reply denies the fact exists");
  if (inventedIdentifiers.length) reasons.push(`invented identifier(s) not in ground truth: ${inventedIdentifiers.join(", ")}`);

  return {
    pass: missingFacts.length === 0 && !failsForDenial && inventedIdentifiers.length === 0,
    missingFacts,
    deniedFacts,
    inventedIdentifiers,
    reasons,
  };
}
