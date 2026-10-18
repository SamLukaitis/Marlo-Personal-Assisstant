import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One calendar per family: which one Joyce is given, that she can't reach the other, and that the
// subscribe feed follows the same rule. The model is stubbed: each test scripts what it "says"
// and reads back the tools and prompt Joyce sent it.
const ai = vi.hoisted(() => ({
  requests: [] as { tools: { name: string }[]; system: string; messages: unknown[] }[],
  /** Replies in order; a string is a text reply, an object a tool call. */
  script: [] as (string | { tool: string; input: Record<string, unknown> })[],
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async (req: { tools: { name: string }[]; system: string; messages: unknown[] }) => {
        ai.requests.push({ ...req, messages: [...req.messages] });
        const next = ai.script.shift() ?? "OK";
        const content =
          typeof next === "string"
            ? [{ type: "text", text: next }]
            : [{ type: "tool_use", id: `t${ai.requests.length}`, name: next.tool, input: next.input }];
        return { content, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
  },
}));

process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";

const { handleOnboarding } = await import("./onboarding.js");
const { openFamilySessionForPhone } = await import("./familyDb.js");
const { addEvent, getFamilyJoinCode, listEventsBetween, saveMyGoogleAccount, setMemberName } = await import(
  "./store.js"
);
const { setBuiltInCalendarEnabled } = await import("./adminRecords.js");
const { calendarMode } = await import("./calendarMode.js");
const { runJoyceTurn } = await import("./assistant.js");
const { runCalendarTool } = await import("./calendarTools.js");
const { buildCalendarFeed } = await import("./calendarFeed.js");

type Session = NonNullable<ReturnType<typeof openFamilySessionForPhone>>;

let n = 0;
function family(): { session: Session; phone: string } {
  n += 1;
  const phone = `4477006${String(n).padStart(5, "0")}`;
  handleOnboarding(phone, "hi");
  const outcome = handleOnboarding(phone, "new");
  if (!outcome.done) throw new Error("no family");
  setMemberName(outcome.session, "Ana");
  return { session: openFamilySessionForPhone(phone)!, phone };
}

function connectGoogle(session: Session) {
  saveMyGoogleAccount(session, {
    email: "ana@example.com",
    accessToken: "a",
    refreshToken: "r",
    expiryDate: null,
    timeZone: "Europe/London",
  });
}

const dentist = {
  title: "Dentist",
  allDay: false,
  startsAt: Date.now() + 86_400_000,
  endsAt: Date.now() + 90_000_000,
  aboutMemberId: null,
};

const toolNames = (i = 0) => ai.requests[i].tools.map((t) => t.name);

beforeEach(() => {
  ai.requests.length = 0;
  ai.script = [];
});

afterEach(() => setBuiltInCalendarEnabled(true));

describe("which calendar a family uses", () => {
  it("is Joyce's own until someone connects Google, then Google", () => {
    const { session } = family();
    expect(calendarMode(session)).toBe("built_in");
    connectGoogle(session);
    expect(calendarMode(session)).toBe("google");
  });

  it("is none when the built-in calendar is switched off and nobody has Google", () => {
    const { session } = family();
    setBuiltInCalendarEnabled(false);
    expect(calendarMode(session)).toBe("none");
    // The switch doesn't touch a family already on Google.
    connectGoogle(session);
    expect(calendarMode(session)).toBe("google");
  });
});

describe("the tools Joyce is given", () => {
  it("are only the built-in calendar's, plus connecting Google, for a family without Google", async () => {
    const { session, phone } = family();
    await runJoyceTurn({ session, normalizedPhone: phone }, "what's on this week?");
    expect(toolNames()).toEqual(expect.arrayContaining(["add_event", "list_events", "calendar_link", "connect_google_calendar"]));
    expect(toolNames()).not.toContain("add_calendar_event");
    expect(toolNames()).not.toContain("create_family_calendar");
    expect(ai.requests[0].system).toContain("one you keep yourself");
  });

  it("are only Google's once someone has connected it", async () => {
    const { session, phone } = family();
    connectGoogle(session);
    await runJoyceTurn({ session, normalizedPhone: phone }, "what's on this week?");
    expect(toolNames()).toEqual(expect.arrayContaining(["add_calendar_event", "list_calendar_events", "create_family_calendar"]));
    for (const builtIn of ["add_event", "list_events", "update_event", "delete_event", "calendar_link"]) {
      expect(toolNames()).not.toContain(builtIn);
    }
    expect(ai.requests[0].system).toContain("it is the only calendar");
  });

  it("include no calendar at all, only connecting Google, when the built-in one is off", async () => {
    const { session, phone } = family();
    setBuiltInCalendarEnabled(false);
    await runJoyceTurn({ session, normalizedPhone: phone }, "add the dentist on Tuesday");
    expect(toolNames()).toContain("connect_google_calendar");
    for (const t of ["add_event", "list_events", "add_calendar_event", "list_calendar_events"]) {
      expect(toolNames()).not.toContain(t);
    }
    expect(ai.requests[0].system).toContain("The family has no calendar yet");
  });

  it("can't reach the built-in calendar once the family is on Google, even if the model asks", async () => {
    const { session, phone } = family();
    connectGoogle(session);
    ai.script = [{ tool: "add_event", input: { title: "Dentist", start: "2026-11-03T15:00" } }, "Done"];
    await runJoyceTurn({ session, normalizedPhone: phone }, "add the dentist");
    expect(JSON.stringify(ai.requests[1].messages)).toContain("isn't in use for this family");
    expect(listEventsBetween(session, 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it("can't add to the built-in calendar while it's switched off", async () => {
    const { session, phone } = family();
    setBuiltInCalendarEnabled(false);
    ai.script = [{ tool: "add_event", input: { title: "Dentist", start: "2026-11-03T15:00" } }, "Done"];
    await runJoyceTurn({ session, normalizedPhone: phone }, "add the dentist");
    expect(listEventsBetween(session, 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });
});

describe("connecting Google from the built-in calendar", () => {
  it("warns that events Joyce has been keeping won't move across", async () => {
    const { session, phone } = family();
    addEvent(session, dentist);
    addEvent(session, { ...dentist, title: "Swimming" });
    const out = await runCalendarTool({ session, normalizedPhone: phone }, "connect_google_calendar", {});
    expect(out.forcedReply).toContain("2 upcoming events I've been keeping won't move across");
  });

  it("says nothing about it when there's nothing to move, or the family is already on Google", async () => {
    const empty = family();
    const a = await runCalendarTool({ session: empty.session, normalizedPhone: empty.phone }, "connect_google_calendar", {});
    expect(a.forcedReply).not.toContain("won't move across");

    const onGoogle = family();
    addEvent(onGoogle.session, dentist);
    connectGoogle(onGoogle.session);
    const b = await runCalendarTool({ session: onGoogle.session, normalizedPhone: onGoogle.phone }, "connect_google_calendar", {});
    expect(b.forcedReply).not.toContain("won't move across");
  });
});

describe("the subscribe feed", () => {
  it("goes empty when the family moves to Google or the built-in calendar is off, and comes back", () => {
    const { session } = family();
    addEvent(session, dentist);
    expect(buildCalendarFeed(session)).toContain("SUMMARY:Dentist");

    setBuiltInCalendarEnabled(false);
    const off = buildCalendarFeed(session);
    expect(off).toContain("BEGIN:VCALENDAR");
    expect(off).not.toContain("Dentist");

    setBuiltInCalendarEnabled(true);
    expect(buildCalendarFeed(session)).toContain("SUMMARY:Dentist");

    connectGoogle(session);
    expect(buildCalendarFeed(session)).not.toContain("Dentist");
  });
});

// A second member in the same family shares its mode: it's the family's, not the person's.
describe("a family's members", () => {
  it("all see Google once any one of them connects it", () => {
    const { session } = family();
    n += 1;
    const other = `4477006${String(n).padStart(5, "0")}`;
    handleOnboarding(other, "hi");
    handleOnboarding(other, getFamilyJoinCode(session)!);
    connectGoogle(session);
    expect(calendarMode(openFamilySessionForPhone(other)!)).toBe("google");
  });
});
