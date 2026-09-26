// The WhatsApp Simulator's own record of each simulated conversation — what the simulated user
// typed or tapped, and every send the providers/whatsapp.ts functions intercepted for a simulated
// number instead of calling Meta. The simulator page reads this rather than whatsapp_messages
// because that table needs an owner: a brand-new test user mid-signup has no account yet, so
// nothing registration sends would ever show up there. Also the only place buttons, list options
// and link buttons survive as data the page can render as tappable chips.
//
// In memory on purpose: it's a staging-only test tool, and losing a transcript to a restart costs
// nothing — the conversation's real effects (accounts, onboarding state, memories) live in the DB
// either way.

export interface SimChoice {
  id: string;
  title: string;
}

export interface SimTranscriptEntry {
  id: number;
  at: number;
  role: "user" | "assistant";
  text: string;
  /** Reply buttons or list rows — tapping one sends that id back as a button reply. */
  choices?: SimChoice[];
  /** A cta_url button — a plain link, never a webhook event of its own. */
  link?: { label: string; url: string };
  /** A location_request_message — the simulator shows a "Send location" button for it. */
  locationRequest?: boolean;
}

// Plenty for a test conversation without letting a long-lived staging process grow unbounded.
const MAX_ENTRIES_PER_PHONE = 300;

const transcripts = new Map<string, SimTranscriptEntry[]>();
let nextId = 1;

function key(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}

export function recordSimMessage(phone: string, entry: Omit<SimTranscriptEntry, "id" | "at">): void {
  const k = key(phone);
  const list = transcripts.get(k) ?? [];
  list.push({ ...entry, id: nextId++, at: Date.now() });
  if (list.length > MAX_ENTRIES_PER_PHONE) list.splice(0, list.length - MAX_ENTRIES_PER_PHONE);
  transcripts.set(k, list);
}

export function getSimTranscript(phone: string): SimTranscriptEntry[] {
  return [...(transcripts.get(key(phone)) ?? [])];
}

export function clearSimTranscript(phone: string): void {
  transcripts.delete(key(phone));
}
