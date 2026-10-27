// Submits Joyce's message templates to Meta for approval, or shows their status.
//
//   npm run joyce:templates -- <WABA_ID>            # show what exists and its approval status
//   npm run joyce:templates -- <WABA_ID> --create   # submit any that don't exist yet
//
// Templates belong to the WhatsApp Business Account, not a phone number, so Joyce's sit beside
// Marlo's (marlowe_alert, marlowe_digest) on the same account and are sent from her number.
// Approval usually takes minutes to a day; until then joyce/reminderDelivery.ts's template sends
// fail and those reminders wait for the person's next message instead.
//
// Use the WhatsApp Business Account id 1574262347469069 ("Marlo"). 1576415707195454 reads the
// same numbers and templates but refuses template creation with "WhatsApp accounts cannot be used
// with this API" (seen 2026-10-17) — it isn't the account the templates actually live on.
//
// Meta's rules this is written around: a body can't start or end with a variable, variables
// need an example, and this account uses named variables. The name, language and variable name
// must match JOYCE_REMINDER_TEMPLATE / JOYCE_RELAY_TEMPLATE in joyce/whatsapp.ts. Never prints
// the token.
//
// joyce_family_message is worded as a notification of activity in the recipient's own family
// group, with fixed text either side of the message, rather than as a bare forwarded message:
// Meta treats a template that's mostly one free-text variable as vague, and anything that reads
// as promotional as MARKETING.
import "dotenv/config";
import { JOYCE_RELAY_TEMPLATE, JOYCE_REMINDER_TEMPLATE } from "../joyce/whatsapp.js";

const GRAPH = "https://graph.facebook.com/v21.0";
const token = process.env.JOYCE_WHATSAPP_TOKEN ?? process.env.WHATSAPP_TOKEN;
const wabaId = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const doCreate = process.argv.includes("--create");

const TEMPLATES = [
  {
    name: JOYCE_REMINDER_TEMPLATE.name,
    language: JOYCE_REMINDER_TEMPLATE.language,
    category: "UTILITY",
    parameter_format: "NAMED",
    components: [
      {
        type: "BODY",
        text: `Reminder: {{${JOYCE_REMINDER_TEMPLATE.param}}}\n\nReply here if you need anything.`,
        example: {
          body_text_named_params: [
            { param_name: JOYCE_REMINDER_TEMPLATE.param, example: "Leo's dentist appointment at 4pm today" },
          ],
        },
      },
    ],
  },
  {
    name: JOYCE_RELAY_TEMPLATE.name,
    language: JOYCE_RELAY_TEMPLATE.language,
    category: "UTILITY",
    parameter_format: "NAMED",
    components: [
      {
        type: "BODY",
        text:
          `Hi {{${JOYCE_RELAY_TEMPLATE.params.recipient}}}, you have a new message from ` +
          `{{${JOYCE_RELAY_TEMPLATE.params.sender}}} in your family group:\n\n` +
          `"{{${JOYCE_RELAY_TEMPLATE.params.message}}}"\n\n` +
          "Reply here if you'd like me to pass anything back.",
        example: {
          body_text_named_params: [
            { param_name: JOYCE_RELAY_TEMPLATE.params.recipient, example: "Ella" },
            { param_name: JOYCE_RELAY_TEMPLATE.params.sender, example: "Jake" },
            { param_name: JOYCE_RELAY_TEMPLATE.params.message, example: "I'll be home late tonight, so don't wait for me for dinner." },
          ],
        },
      },
    ],
  },
];

async function graph(path: string, init: RequestInit = {}): Promise<{ ok: boolean; body: any }> {
  const res = await fetch(`${GRAPH}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  return { ok: res.ok, body: await res.json().catch(() => ({})) };
}

async function main(): Promise<void> {
  if (!token) throw new Error("WHATSAPP_TOKEN (or JOYCE_WHATSAPP_TOKEN) is not set in server/.env");
  if (!wabaId) throw new Error("Pass the WhatsApp Business Account id, e.g. npm run joyce:templates -- 1574262347469069");

  for (const template of TEMPLATES) {
    const existing = await graph(
      `${wabaId}/message_templates?name=${encodeURIComponent(template.name)}&fields=name,language,status,category,rejected_reason`
    );
    if (!existing.ok) throw new Error(`couldn't list templates: ${JSON.stringify(existing.body.error ?? existing.body)}`);
    const match = (existing.body.data ?? []).find(
      (t: { name: string; language: string }) => t.name === template.name && t.language === template.language
    );
    if (match) {
      const reason = match.rejected_reason && match.rejected_reason !== "NONE" ? ` (${match.rejected_reason})` : "";
      console.log(`${template.name} [${template.language}]: ${match.status}${reason}`);
      continue;
    }
    if (!doCreate) {
      console.log(`${template.name} [${template.language}]: not created yet — rerun with --create to submit it`);
      continue;
    }
    const created = await graph(`${wabaId}/message_templates`, { method: "POST", body: JSON.stringify(template) });
    if (!created.ok) {
      console.log(`${template.name}: submission failed — ${JSON.stringify(created.body.error ?? created.body)}`);
      process.exitCode = 1;
      continue;
    }
    console.log(`${template.name} [${template.language}]: submitted, id ${created.body.id}, status ${created.body.status}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
