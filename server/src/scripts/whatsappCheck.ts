// One-shot health check for the WhatsApp Cloud API wiring — run from server/:
//
//   npm run whatsapp:check                       # token + phone number + app webhook only
//   npm run whatsapp:check -- <WABA_ID>          # also: numbers, webhook subscription, templates
//   npm run whatsapp:check -- <WABA_ID> --subscribe   # ...and subscribe the WABA to this app
//
// Why this exists: when the number moved from Meta's free test number to a real business number
// on a brand-new WhatsApp Business Account (WABA), outbound sending kept working but inbound
// messages stopped arriving. The app-level webhook URL was fine — the missing piece was that a
// WABA only delivers events to an app it is *subscribed* to (POST /{WABA_ID}/subscribed_apps),
// which Meta does automatically for the test WABA but not for one created through business
// verification. There's no button for that in the Meta dashboard, hence this script.
//
// Reads WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_APP_SECRET from server/.env — so it
// checks whatever *this* .env says, which may differ from what Railway is running with. Never
// prints the token or secret themselves.
import "dotenv/config";

const GRAPH = "https://graph.facebook.com/v21.0";
// Body-template names outbound.ts needs approved on whichever WABA the live number sits in — see
// sendWhatsAppTemplate in providers/whatsapp.ts.
const REQUIRED_TEMPLATES = ["marlowe_alert", "marlowe_digest"];

const token = process.env.WHATSAPP_TOKEN;
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
const appSecret = process.env.WHATSAPP_APP_SECRET;
const wabaId = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const doSubscribe = process.argv.includes("--subscribe");

let problems = 0;
function ok(msg: string) {
  console.log(`  ✔ ${msg}`);
}
function bad(msg: string) {
  problems++;
  console.log(`  ✘ ${msg}`);
}

async function graph(
  path: string,
  opts: { token?: string; method?: "GET" | "POST" } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: opts.method ?? "GET",
    headers: { Authorization: `Bearer ${opts.token ?? token}` },
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

function errMsg(body: Record<string, unknown>): string {
  const e = body.error as { message?: string; code?: number } | undefined;
  return e ? `${e.message ?? "unknown error"} (code ${e.code ?? "?"})` : JSON.stringify(body);
}

async function main() {
  if (!token || !phoneNumberId) {
    console.error("WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID must be set in server/.env");
    process.exit(1);
  }

  console.log("\n1. Access token");
  const dbg = await graph(`debug_token?input_token=${encodeURIComponent(token)}`);
  const d = dbg.body.data as
    | { is_valid?: boolean; type?: string; app_id?: string; expires_at?: number; scopes?: string[] }
    | undefined;
  let appId: string | undefined;
  if (dbg.status !== 200 || !d?.is_valid) {
    bad(`token is not valid: ${errMsg(dbg.body)}`);
  } else {
    appId = d.app_id;
    ok(`valid ${d.type} token for app ${d.app_id}`);
    if (d.expires_at === 0) ok("never expires (permanent System User token)");
    else bad(`expires at ${new Date((d.expires_at ?? 0) * 1000).toISOString()} — use a permanent System User token`);
    for (const s of ["whatsapp_business_messaging", "whatsapp_business_management"]) {
      if (d.scopes?.includes(s)) ok(`has scope ${s}`);
      else bad(`missing scope ${s}`);
    }
  }

  console.log(`\n2. Phone number ${phoneNumberId}`);
  const ph = await graph(
    `${phoneNumberId}?fields=id,display_phone_number,verified_name,status,platform_type,code_verification_status,quality_rating,messaging_limit_tier`
  );
  if (ph.status !== 200) {
    bad(`cannot read phone number: ${errMsg(ph.body)}`);
    console.log("    → the ID is wrong, or the token's System User isn't assigned to this number's WABA");
  } else {
    const p = ph.body as Record<string, string>;
    ok(`${p.display_phone_number} — "${p.verified_name}"`);
    if (p.status === "CONNECTED") ok("status CONNECTED");
    else bad(`status is ${p.status} (expected CONNECTED)`);
    if (p.platform_type === "CLOUD_API") ok("registered with Cloud API");
    else bad(`platform_type is ${p.platform_type} — register the number (API Setup → Register / two-step PIN)`);
    if (p.code_verification_status === "VERIFIED") ok("number ownership verified");
    else bad(`code_verification_status is ${p.code_verification_status}`);
    console.log(`    quality: ${p.quality_rating ?? "?"}, messaging tier: ${p.messaging_limit_tier ?? "?"}`);
  }

  console.log("\n3. App-level webhook (what Meta calls, for every WABA subscribed to the app)");
  if (!appId || !appSecret) {
    console.log("    (skipped — needs a valid token and WHATSAPP_APP_SECRET)");
  } else {
    const subs = await graph(`${appId}/subscriptions`, { token: `${appId}|${appSecret}` });
    if (subs.status !== 200) {
      bad(`cannot read app subscriptions: ${errMsg(subs.body)} — WHATSAPP_APP_SECRET may be wrong`);
    } else {
      const list = (subs.body.data as Array<{ object: string; callback_url: string; active: boolean; fields: Array<{ name: string }> }>) ?? [];
      const wa = list.find((s) => s.object === "whatsapp_business_account");
      if (!wa) bad("no webhook configured for whatsapp_business_account (WhatsApp → Configuration → Webhook)");
      else {
        ok(`callback URL: ${wa.callback_url}${wa.active ? "" : " (INACTIVE)"}`);
        if (!wa.callback_url.endsWith("/webhooks/whatsapp")) bad("callback URL should end in /webhooks/whatsapp");
        if (wa.fields.some((f) => f.name === "messages")) ok("subscribed to the 'messages' field");
        else bad("not subscribed to the 'messages' field");
      }
    }
  }

  if (!wabaId) {
    console.log(
      "\n4–6. WABA checks skipped — re-run with the WhatsApp Business Account ID\n" +
        "     (Meta for Developers → your app → WhatsApp → API Setup → 'WhatsApp Business Account ID',\n" +
        "      or Business Settings → Accounts → WhatsApp accounts → ID under the account name)."
    );
  } else {
    console.log(`\n4. Phone numbers in WABA ${wabaId}`);
    const nums = await graph(`${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,status`);
    if (nums.status !== 200) {
      bad(`cannot read WABA: ${errMsg(nums.body)} — wrong ID, or the System User isn't assigned to this WABA`);
    } else {
      const list = (nums.body.data as Array<Record<string, string>>) ?? [];
      for (const n of list) console.log(`    ${n.id}  ${n.display_phone_number}  "${n.verified_name}"  ${n.status}`);
      if (list.some((n) => n.id === phoneNumberId)) ok(`WHATSAPP_PHONE_NUMBER_ID ${phoneNumberId} belongs to this WABA`);
      else bad(`WHATSAPP_PHONE_NUMBER_ID ${phoneNumberId} is NOT in this WABA — the number you're messaging and the number the server sends from are on different accounts`);
    }

    console.log(`\n5. Is WABA ${wabaId} subscribed to app ${appId ?? "?"}? (this is what makes inbound webhooks fire)`);
    const sa = await graph(`${wabaId}/subscribed_apps`);
    if (sa.status !== 200) {
      bad(`cannot read subscribed_apps: ${errMsg(sa.body)}`);
    } else {
      const apps = (sa.body.data as Array<{ whatsapp_business_api_data?: { id?: string; name?: string; link?: string } }>) ?? [];
      const mine = apps.find((a) => a.whatsapp_business_api_data?.id === appId);
      if (mine) ok(`subscribed to "${mine.whatsapp_business_api_data?.name}" (${appId}) — inbound webhooks should reach the server`);
      else {
        bad(`NOT subscribed to app ${appId} (currently: ${apps.length === 0 ? "no apps" : apps.map((a) => a.whatsapp_business_api_data?.id).join(", ")})`);
        if (doSubscribe) {
          const r = await graph(`${wabaId}/subscribed_apps`, { method: "POST" });
          if (r.status === 200 && r.body.success) {
            problems--;
            ok("subscribed now — send a WhatsApp message to the business number and watch the Railway logs");
          } else bad(`subscribe failed: ${errMsg(r.body)}`);
        } else {
          console.log("    → re-run with --subscribe to fix this");
        }
      }
    }

    console.log(`\n6. Message templates on WABA ${wabaId} (needed for proactive pushes after the 24h window)`);
    const tpl = await graph(`${wabaId}/message_templates?fields=name,status,language&limit=100`);
    if (tpl.status !== 200) {
      bad(`cannot read templates: ${errMsg(tpl.body)}`);
    } else {
      const list = (tpl.body.data as Array<{ name: string; status: string; language: string }>) ?? [];
      for (const name of REQUIRED_TEMPLATES) {
        const t = list.find((x) => x.name === name && x.language === "en_US");
        if (!t) bad(`template ${name} (en_US) does not exist on this WABA — create it in WhatsApp Manager → Message templates`);
        else if (t.status !== "APPROVED") bad(`template ${name} exists but is ${t.status}`);
        else ok(`template ${name} approved`);
      }
    }
  }

  console.log(problems === 0 ? "\nAll checks passed.\n" : `\n${problems} problem(s) found.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
