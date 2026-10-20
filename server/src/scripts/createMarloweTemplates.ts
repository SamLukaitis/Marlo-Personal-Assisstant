// Submits Marlowe's marlowe_whats_new template to Meta for approval, or shows its status.
//
//   npm run whatsapp:templates -- <WABA_ID>            # show its approval status
//   npm run whatsapp:templates -- <WABA_ID> --create   # submit it if it doesn't exist yet
//
// Use the WhatsApp Business Account id 1574262347469069 ("Marlowe"); see createJoyceTemplates.ts
// for why not 1576415707195454. marlowe_alert and marlowe_digest were made by hand in the Meta
// dashboard and aren't managed here.
//
// marlowe_whats_new carries the Portal's update announcements (services/announcements.ts) to
// people outside WhatsApp's 24-hour window. It's MARKETING on purpose: announcing features is
// promotional in Meta's terms, and sending it under a utility template risks Meta pausing the
// utility templates that alerts and briefings depend on. The name and variable must match
// TEMPLATE_PARAM_NAME in providers/whatsapp.ts. Never prints the token.
import "dotenv/config";

const GRAPH = "https://graph.facebook.com/v21.0";
const token = process.env.WHATSAPP_TOKEN;
const wabaId = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const doCreate = process.argv.includes("--create");

const TEMPLATES = [
  {
    name: "marlowe_whats_new",
    language: "en_US",
    category: "MARKETING",
    parameter_format: "NAMED",
    components: [
      {
        type: "BODY",
        text: "What's new in Marlowe: {{update_text}}\n\nReply here with any questions.",
        example: {
          body_text_named_params: [
            {
              param_name: "update_text",
              example:
                "Marlowe can now search live hotel prices for your dates. Try: find me a hotel in Lisbon 12-15 Nov. Reply \"stop updates\" if you'd rather not get these.",
            },
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
  if (!token) throw new Error("WHATSAPP_TOKEN is not set in server/.env");
  if (!wabaId) throw new Error("Pass the WhatsApp Business Account id, e.g. npm run whatsapp:templates -- 1574262347469069");

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
      console.log(`${template.name} [${template.language}]: ${match.status}, ${match.category}${reason}`);
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
