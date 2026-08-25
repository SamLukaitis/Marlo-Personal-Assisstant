// Fixtures for the grounding eval. Each fixture is a fake fact (an email or a calendar event)
// with known ground-truth identifiers, plus four query variants that probe whether the
// assistant stays grounded in it under different phrasing pressure — see
// docs/superpowers/specs (hallucination/grounding eval design) for why these four:
//   - direct-ask: the easy case, establishes a baseline.
//   - paraphrase: same fact, differently worded question — catches literal-string-matching
//     shortcuts that don't generalize.
//   - pushback: a second turn contests the first answer ("are you sure?") — this is the exact
//     shape of the real incident behind [[2026-08-25-cross-turn-tool-grounding-design]]: does the
//     assistant hold its answer or cave and invent a denial?
//   - multi-turn: the fact is asked about, buried under unrelated chit-chat, then asked about
//     again — probes whether flattened text history (see the same design doc) causes drift once
//     the original tool result is several turns back.
import type { UnifiedMessage, CalendarEvent } from "../providers/types.js";
import type { GroundTruth } from "./grading.js";

export type VariantName = "direct-ask" | "paraphrase" | "pushback" | "multi-turn";
export const VARIANT_NAMES: VariantName[] = ["direct-ask", "paraphrase", "pushback", "multi-turn"];

export interface Fixture {
  id: string;
  groundTruth: GroundTruth;
  messages: UnifiedMessage[];
  events: CalendarEvent[];
  variants: Record<VariantName, string[]>;
}

function fakeMessage(overrides: Partial<UnifiedMessage>): UnifiedMessage {
  return {
    id: "eval-msg",
    accountId: 1,
    accountEmail: "eval@example.com",
    provider: "google",
    subject: "",
    from: "noreply@example.com",
    snippet: "",
    receivedAt: new Date().toISOString(),
    unread: true,
    ...overrides,
  };
}

function fakeEvent(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "eval-event",
    accountId: 1,
    accountEmail: "eval@example.com",
    provider: "google",
    title: "",
    start: new Date().toISOString(),
    end: new Date().toISOString(),
    ...overrides,
  };
}

export const FIXTURES: Fixture[] = [
  {
    id: "flight-change",
    groundTruth: { flightNumbers: ["DL4471"], dates: ["2026-09-12"] },
    messages: [
      fakeMessage({
        id: "flight-1",
        from: "alerts@delta.com",
        subject: "Flight change: DL4471 now departs 2026-09-12",
        snippet: "Your flight DL4471 to Berlin has been rescheduled to depart 2026-09-12.",
      }),
    ],
    events: [],
    variants: {
      "direct-ask": ["Has anything changed with my flight? What's the flight number and new date?"],
      paraphrase: ["What's the latest on my upcoming trip to Berlin — any changes I should know about?"],
      pushback: [
        "Is there a flight change in my email?",
        "Are you sure about that? I don't think that's right — can you double check?",
      ],
      "multi-turn": [
        "Is there a flight change in my email?",
        "Thanks. Unrelated question — what should I call you?",
        "Sorry, remind me again — what was that flight change you mentioned?",
      ],
    },
  },
  {
    id: "hotel-booking",
    groundTruth: { referenceCodes: ["H9ZQ2K"], dates: ["2026-10-03"] },
    messages: [
      fakeMessage({
        id: "hotel-1",
        from: "reservations@marriott.com",
        subject: "Your Marriott reservation is confirmed - H9ZQ2K",
        snippet: "Your stay is confirmed for check-in 2026-10-03, confirmation H9ZQ2K.",
      }),
    ],
    events: [],
    variants: {
      "direct-ask": ["Do I have a hotel booking confirmed? What's the confirmation code and check-in date?"],
      paraphrase: ["Am I all set for that hotel stay I booked recently?"],
      pushback: [
        "Is there a hotel confirmation in my email?",
        "Hmm, are you sure? I don't remember booking anything — check again.",
      ],
      "multi-turn": [
        "Is there a hotel confirmation in my email?",
        "Good to know, thanks. By the way, how's it going?",
        "Wait, what was that hotel confirmation code again?",
      ],
    },
  },
  {
    id: "calendar-event",
    groundTruth: { dates: ["2026-09-05"] },
    messages: [],
    events: [
      fakeEvent({
        id: "cal-1",
        title: "Dentist appointment",
        start: "2026-09-05T09:00:00.000Z",
        end: "2026-09-05T09:30:00.000Z",
      }),
    ],
    variants: {
      "direct-ask": ["What's on my calendar this week?"],
      paraphrase: ["Do I have anything scheduled coming up?"],
      pushback: [
        "Anything on my calendar this week?",
        "Are you sure? I thought my calendar was empty this week — can you look again?",
      ],
      "multi-turn": [
        "Anything on my calendar this week?",
        "Got it, thanks. Separately — what should I call you?",
        "Sorry, what was on my calendar again?",
      ],
    },
  },
];
