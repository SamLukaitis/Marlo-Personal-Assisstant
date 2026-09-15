// Sends one proactive push to every registered number, remembering which numbers already have it.
// Callers (scheduler.ts's briefing, memoryReminders.ts, tripPrep.ts, importantEmailAlerts.ts) only
// mark an item done once every number has it and retry on the next tick otherwise — this is what
// keeps that retry from re-sending to the numbers that succeeded the first time.
import { listProactiveDeliveryPhones, recordProactiveDelivery } from "../db/store.js";
import { sendProactiveMessage, type ProactiveMessageKind } from "./outbound.js";

// `itemKey` must identify this exact push (e.g. "reminder:<note id>:<trigger_at>") so a retry of
// the same item finds its earlier deliveries. Returns true once every number has received it.
export async function sendToAllNumbers(
  ownerId: number,
  itemKey: string,
  numbers: string[],
  text: string,
  kind: ProactiveMessageKind,
  logPrefix: string
): Promise<boolean> {
  const alreadyDelivered = new Set(listProactiveDeliveryPhones(ownerId, itemKey));
  let allSucceeded = true;
  for (const number of numbers) {
    if (alreadyDelivered.has(number)) continue;
    try {
      await sendProactiveMessage(number, text, kind);
      recordProactiveDelivery(ownerId, itemKey, number);
    } catch (err) {
      console.error(`${logPrefix}: failed to send`, err);
      allSucceeded = false;
    }
  }
  return allSucceeded;
}
