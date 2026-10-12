// What Marlowe does once a phone action finishes — filled in by the follow-ups task.
import type { PhoneActionRow } from "../db/store.js";

export async function handleFinishedPhoneAction(_row: PhoneActionRow, _now: number): Promise<void> {}
