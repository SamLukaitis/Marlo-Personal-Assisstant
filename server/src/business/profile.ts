// What the user's business does, in their words ("plumber in Leeds") — feeds the categoriser and
// the assistant's prompt. One line in settings; no table needed.
import { getSetting, setSetting } from "../db/store.js";

const KEY = "business_description";

export function getBusinessDescription(ownerId: number): string | null {
  return getSetting(ownerId, KEY)?.trim() || null;
}

export function setBusinessDescription(ownerId: number, description: string): void {
  const clean = description.trim().slice(0, 200);
  if (!clean) throw new Error("Business description can't be empty.");
  setSetting(ownerId, KEY, clean);
}
