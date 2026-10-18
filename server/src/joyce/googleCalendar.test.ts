import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

// Google is stubbed; everything else (registry, family files, encryption) is real. Each fake
// call records the access token it was made with, which is how these tests tell whose Google
// account a request actually went to.
const g = vi.hoisted(() => ({
  calls: [] as { method: string; token: string | undefined; params: Record<string, unknown> }[],
  exchange: {
    tokens: {
      access_token: "new-access",
      refresh_token: "new-refresh" as string | undefined,
      expiry_date: 1,
      scope: "openid https://www.googleapis.com/auth/calendar.events",
    },
    email: "priya@example.com",
  },
  events: [] as Record<string, unknown>[],
  calendars: [] as Record<string, unknown>[],
  /** Makes one method fail with an HTTP status when called with a given access token. */
  failures: [] as { method: string; token: string; status: number }[],
}));

vi.mock("googleapis", () => {
  class OAuth2 {
    creds: { access_token?: string } = {};
    setCredentials(c: { access_token?: string }) {
      this.creds = c;
    }
    on() {}
    generateAuthUrl(opts: { state: string }) {
      return `https://accounts.google.test/auth?state=${opts.state}`;
    }
    async getToken() {
      return { tokens: g.exchange.tokens };
    }
    async revokeToken(token: string) {
      g.calls.push({ method: "revoke", token, params: {} });
    }
  }
  const record = (auth: OAuth2, method: string, result: unknown) => async (params: Record<string, unknown>) => {
    g.calls.push({ method, token: auth.creds.access_token, params });
    const failure = g.failures.find((f) => f.method === method && f.token === auth.creds.access_token);
    if (failure) throw Object.assign(new Error(`HTTP ${failure.status}`), { response: { status: failure.status } });
    return { data: typeof result === "function" ? (result as (p: unknown) => unknown)(params) : result };
  };
  return {
    google: {
      auth: { OAuth2 },
      oauth2: () => ({ userinfo: { get: async () => ({ data: { email: g.exchange.email } }) } }),
      calendar: ({ auth }: { auth: OAuth2 }) => ({
        calendarList: {
          get: record(auth, "calendarList.get", { id: "primary", timeZone: "Europe/London" }),
          list: record(auth, "calendarList.list", () => ({ items: g.calendars })),
          insert: record(auth, "calendarList.insert", {}),
        },
        calendars: { insert: record(auth, "calendars.insert", { id: "family-cal@group.calendar.google.com" }) },
        acl: { insert: record(auth, "acl.insert", {}), delete: record(auth, "acl.delete", {}) },
        events: {
          list: record(auth, "events.list", () => ({ items: g.events })),
          insert: record(auth, "events.insert", (p: { requestBody: Record<string, unknown> }) => ({
            id: "evt-new",
            start: p.requestBody.start,
          })),
          get: record(auth, "events.get", {
            summary: "Dentist",
            start: { dateTime: "2026-10-20T15:00:00+01:00" },
            end: { dateTime: "2026-10-20T15:30:00+01:00" },
          }),
          patch: record(auth, "events.patch", (p: { requestBody: Record<string, unknown> }) => ({
            summary: "Dentist",
            start: p.requestBody.start,
          })),
          delete: record(auth, "events.delete", {}),
        },
      }),
    },
  };
});

process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";

const {
  createFamily,
  joinFamilyByCode,
  issueGoogleConnectToken,
  isGoogleConnectTokenLive,
  requestLeave,
  __registryForTests,
} = await import("./registry.js");
const { openFamilySessionForGoogleConnect, openFamilySessionForNewMember, openFamilySessionForPhone } =
  await import("./familyDb.js");
const { getFamilyCalendar, getGoogleAccount, listGoogleAccounts, saveMyGoogleAccount, setMemberName } =
  await import("./store.js");
const { runCalendarTool, CALENDAR_TOOLS } = await import("./calendarTools.js");
const { eventTimes, startOfDayIn } = await import("./googleCalendar.js");
const { joyceGoogleRoutes } = await import("./googleRoutes.js");
const { composeReply } = await import("./routes.js");

type Session = NonNullable<ReturnType<typeof openFamilySessionForPhone>>;

function familyOf(phone: string, name: string) {
  const { family, joinCode } = createFamily(phone);
  setMemberName(openFamilySessionForNewMember(family, phone), name);
  return { session: openFamilySessionForPhone(phone)!, joinCode };
}

function join(phone: string, code: string, name: string): Session {
  const out = joinFamilyByCode(phone, code);
  if (!out.ok) throw new Error("join failed");
  setMemberName(openFamilySessionForNewMember(out.family, phone), name);
  return openFamilySessionForPhone(phone)!;
}

function connect(session: Session, email: string, accessToken: string, timeZone = "Europe/London") {
  saveMyGoogleAccount(session, { email, accessToken, refreshToken: `r-${accessToken}`, expiryDate: null, timeZone });
}

const tool = (session: Session, phone: string, name: string, input: Record<string, unknown> = {}) =>
  runCalendarTool({ session, normalizedPhone: phone }, name, input);

beforeEach(() => {
  g.calls.length = 0;
  g.events = [];
  g.calendars = [{ id: "primary", primary: true, accessRole: "owner" }];
  g.exchange.tokens.refresh_token = "new-refresh";
  g.failures = [];
});

describe("connect links", () => {
  it("work once, for the phone that asked, and a newer link replaces an older one", () => {
    const { session } = familyOf("15553330001", "Priya");
    const first = issueGoogleConnectToken("15553330001");
    const second = issueGoogleConnectToken("15553330001");
    expect(isGoogleConnectTokenLive(first)).toBe(false);
    expect(isGoogleConnectTokenLive(second)).toBe(true);

    const opened = openFamilySessionForGoogleConnect(second)!;
    expect(opened.familyId).toBe(session.familyId);
    expect(opened.actor.id).toBe(session.actor.id);
    expect(openFamilySessionForGoogleConnect(second)).toBeNull();
  });

  it("expire after ten minutes", () => {
    familyOf("15553330002", "Ana");
    const token = issueGoogleConnectToken("15553330002");
    __registryForTests().prepare(`UPDATE google_connect_tokens SET created_at = ?`).run(Date.now() - 11 * 60_000);
    expect(isGoogleConnectTokenLive(token)).toBe(false);
    expect(openFamilySessionForGoogleConnect(token)).toBeNull();
  });

  it("stop working if the member leaves the family before using it", async () => {
    familyOf("15553330003", "Ben");
    const token = issueGoogleConnectToken("15553330003");
    requestLeave("15553330003");
    await composeReply("15553330003", "confirm cancel");
    expect(openFamilySessionForGoogleConnect(token)).toBeNull();
  });

  it("are sent as fixed text by the connect tool, with the family-visibility warning", async () => {
    const { session } = familyOf("15553330004", "Cara");
    const out = await tool(session, "15553330004", "connect_google_calendar");
    expect(out.forcedReply).toMatch(/\/joyce\/google\/connect\?t=/);
    expect(out.forcedReply).toContain("everyone in this family");
    const token = decodeURIComponent(out.forcedReply!.match(/t=([^\s]+)/)![1]);
    expect(isGoogleConnectTokenLive(token)).toBe(true);
  });
});

describe("stored Google accounts", () => {
  it("are encrypted in the family's file", () => {
    const { session } = familyOf("15553330010", "Dev");
    connect(session, "dev@example.com", "secret-access-token");
    const raw = JSON.stringify(session.db.prepare(`SELECT * FROM google_accounts`).all());
    expect(raw).not.toContain("secret-access-token");
    expect(raw).not.toContain("dev@example.com");
    expect(listGoogleAccounts(session)[0].email).toBe("dev@example.com");
  });

  it("keep the old refresh token when Google doesn't send a new one on reconnect", () => {
    const { session } = familyOf("15553330011", "Eve");
    connect(session, "eve@example.com", "a1");
    saveMyGoogleAccount(session, { email: "eve@example.com", accessToken: "a2", refreshToken: null, expiryDate: null, timeZone: "UTC" });
    const [acct] = listGoogleAccounts(session);
    expect(acct.accessToken).toBe("a2");
    expect(acct.refreshToken).toBe("r-a1");
  });

  it("can't be reached by an event ref from another family", async () => {
    const a = familyOf("15553330012", "Fin");
    connect(a.session, "fin@example.com", "fin-token");
    const aSecond = join("15553330013", a.joinCode, "Gus");
    connect(aSecond, "gus@example.com", "gus-token"); // account id 2 in family A

    const b = familyOf("15553330014", "Hal");
    connect(b.session, "hal@example.com", "hal-token"); // account id 1 in family B

    expect(getGoogleAccount(b.session, 2)).toBeNull();
    const out = await tool(b.session, "15553330014", "delete_calendar_event", { event_ref: "2|primary|evt" });
    expect(out.result).toContain("isn't valid");
    expect(g.calls.filter((c) => c.method === "events.delete")).toEqual([]);
  });

  it("are disconnected when their owner leaves the family", async () => {
    const a = familyOf("15553330015", "Ivy");
    const jo = join("15553330016", a.joinCode, "Jo");
    connect(jo, "jo@example.com", "jo-token");
    requestLeave("15553330016");
    await composeReply("15553330016", "confirm cancel");
    expect(listGoogleAccounts(a.session)).toEqual([]);
    expect(g.calls.some((c) => c.method === "revoke" && c.token === "r-jo-token")).toBe(true);
  });

  it("can only be disconnected by their owner", async () => {
    const a = familyOf("15553330017", "Kim");
    connect(a.session, "kim@example.com", "kim-token");
    const lee = join("15553330018", a.joinCode, "Lee");
    const out = await tool(lee, "15553330018", "disconnect_google_calendar");
    expect(out.result).toContain("don't have");
    expect(listGoogleAccounts(a.session)).toHaveLength(1);
  });
});

describe("calendar tools", () => {
  it("add to the speaker's own calendar by default, in their calendar's time zone", async () => {
    const { session } = familyOf("15553330020", "Mo");
    connect(session, "mo@example.com", "mo-token", "America/New_York");
    const out = await tool(session, "15553330020", "add_calendar_event", { title: "Dentist", start: "2026-10-20T15:00" });
    expect(out.result).toContain("their own main calendar");
    const insert = g.calls.find((c) => c.method === "events.insert")!;
    expect(insert.token).toBe("mo-token");
    expect(insert.params.requestBody).toMatchObject({
      summary: "Dentist",
      start: { dateTime: "2026-10-20T15:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-20T16:00:00", timeZone: "America/New_York" },
      description: "Added by Joyce for Mo.",
    });
  });

  it("add to another member's calendar when named, and refuse a name not in the family", async () => {
    const a = familyOf("15553330021", "Nia");
    connect(a.session, "nia@example.com", "nia-token");
    const oz = join("15553330022", a.joinCode, "Oz");

    const out = await tool(oz, "15553330022", "add_calendar_event", { title: "Swim", start: "2026-10-21", whose: "nia" });
    expect(out.result).toContain("Nia's main calendar");
    const insert = g.calls.find((c) => c.method === "events.insert")!;
    expect(insert.token).toBe("nia-token");
    expect(insert.params.requestBody).toMatchObject({ start: { date: "2026-10-21" }, end: { date: "2026-10-22" } });

    const unknown = await tool(oz, "15553330022", "add_calendar_event", { title: "x", start: "2026-10-21", whose: "Pat" });
    expect(unknown.result).toContain('Nobody in this family is called "Pat"');
    const notConnected = await tool(a.session, "15553330021", "add_calendar_event", { title: "x", start: "2026-10-21", whose: "Oz" });
    expect(notConnected.result).toContain("Oz hasn't connected");
  });

  it("list everyone's events with refs that resolve back to the right account", async () => {
    const a = familyOf("15553330023", "Pip");
    connect(a.session, "pip@example.com", "pip-token");
    g.events = [{ id: "e1", summary: "Football", start: { dateTime: "2026-10-20T17:00:00+01:00" }, end: { dateTime: "2026-10-20T18:00:00+01:00" } }];

    const out = await tool(a.session, "15553330023", "list_calendar_events", { from: "2026-10-20", to: "2026-10-20" });
    expect(out.result).toContain("Football");
    const ref = out.result.match(/\[([^\]]+)\] 2026-10-20T17/)![1];
    const list = g.calls.find((c) => c.method === "events.list")!;
    // Midnight to midnight in London (BST), not UTC.
    expect(list.params).toMatchObject({ timeMin: "2026-10-19T23:00:00.000Z", timeMax: "2026-10-20T23:00:00.000Z" });

    await tool(a.session, "15553330023", "change_calendar_event", { event_ref: ref, start: "2026-10-20T16:00" });
    const patch = g.calls.find((c) => c.method === "events.patch")!;
    expect(patch.token).toBe("pip-token");
    expect(patch.params).toMatchObject({ calendarId: "primary", eventId: "e1" });
  });

  it("keep an event's length when only its start moves", async () => {
    const { session } = familyOf("15553330024", "Quinn");
    connect(session, "q@example.com", "q-token");
    await tool(session, "15553330024", "change_calendar_event", { event_ref: "1|primary|e1", start: "2026-10-22T09:00" });
    const patch = g.calls.find((c) => c.method === "events.patch")!;
    expect(patch.params.requestBody).toMatchObject({
      start: { dateTime: "2026-10-22T09:00" },
      end: { dateTime: "2026-10-22T09:30:00" },
    });
  });

  it("say so plainly when nobody has connected a calendar", async () => {
    const { session } = familyOf("15553330025", "Rae");
    const out = await tool(session, "15553330025", "list_calendar_events", { from: "2026-10-20", to: "2026-10-21" });
    expect(out.result).toContain("Nobody in this family has connected");
  });

  it("have no family, phone or member-id parameter", () => {
    for (const t of CALENDAR_TOOLS) {
      const props = Object.keys((t.input_schema as { properties?: object }).properties ?? {});
      expect(props.filter((p) => /family|phone|member|account/i.test(p))).toEqual([]);
    }
  });
});

describe("the family calendar", () => {
  const FAMILY_ID = "family-cal@group.calendar.google.com";
  const callsTo = (method: string) => g.calls.filter((c) => c.method === method);

  /** A family of Ann (connected, London) and Bo (connected, New York), plus Cy (not connected). */
  function threeMembers(base: number) {
    const ann = familyOf(`1555334${base}1`, "Ann");
    connect(ann.session, "ann@example.com", `ann-${base}`);
    const bo = join(`1555334${base}2`, ann.joinCode, "Bo");
    connect(bo, "bo@example.com", `bo-${base}`, "America/New_York");
    const cy = join(`1555334${base}3`, ann.joinCode, "Cy");
    return { ann: ann.session, bo, cy, joinCode: ann.joinCode, phones: [1, 2, 3].map((n) => `1555334${base}${n}`) };
  }

  it("is created in the speaker's account and shared with every other connected member", async () => {
    const f = threeMembers(10);
    const out = await tool(f.bo, f.phones[1], "create_family_calendar", {});
    expect(out.result).toContain('Created "Family"');
    expect(out.result).toContain("Shared with Ann");

    expect(callsTo("calendars.insert")[0]).toMatchObject({
      token: "bo-10",
      params: { requestBody: { summary: "Family", timeZone: "America/New_York" } },
    });
    expect(callsTo("acl.insert")).toEqual([
      expect.objectContaining({
        token: "bo-10",
        params: expect.objectContaining({
          calendarId: FAMILY_ID,
          sendNotifications: false,
          requestBody: { role: "writer", scope: { type: "user", value: "ann@example.com" } },
        }),
      }),
    ]);
    expect(callsTo("calendarList.insert")).toEqual([
      expect.objectContaining({ token: "ann-10", params: { requestBody: { id: FAMILY_ID } } }),
    ]);
    expect(getFamilyCalendar(f.ann)).toEqual({
      calendarId: FAMILY_ID,
      name: "Family",
      timeZone: "America/New_York",
      ownerMemberId: f.bo.actor.id,
    });
    // Stored encrypted, like everything else in the family's file.
    expect(JSON.stringify(f.ann.db.prepare(`SELECT * FROM family_meta`).all())).not.toContain("group.calendar");
  });

  it("needs the speaker to have connected Google, and is only made once", async () => {
    const f = threeMembers(11);
    expect((await tool(f.cy, f.phones[2], "create_family_calendar", {})).result).toContain("connect their Google Calendar first");
    await tool(f.ann, f.phones[0], "create_family_calendar", { name: "Smiths" });
    const again = await tool(f.bo, f.phones[1], "create_family_calendar", {});
    expect(again.result).toContain('already has a calendar, "Smiths"');
    expect(callsTo("calendars.insert")).toHaveLength(1);
  });

  it("gets new events unless someone asks for a person's own calendar", async () => {
    const f = threeMembers(12);
    await tool(f.ann, f.phones[0], "create_family_calendar", {});
    g.calls.length = 0;

    const toFamily = await tool(f.bo, f.phones[1], "add_calendar_event", { title: "BBQ", start: "2026-10-25T13:00" });
    expect(toFamily.result).toContain("family calendar");
    expect(callsTo("events.insert")[0]).toMatchObject({
      token: "bo-12", // through the speaker's own account
      params: { calendarId: FAMILY_ID, requestBody: { start: { dateTime: "2026-10-25T13:00", timeZone: "Europe/London" } } },
    });

    g.calls.length = 0;
    const personal = await tool(f.bo, f.phones[1], "add_calendar_event", { title: "Gym", start: "2026-10-25T07:00", whose: "Bo" });
    expect(personal.result).toContain("their own main calendar");
    expect(callsTo("events.insert")[0]).toMatchObject({ token: "bo-12", params: { calendarId: "primary" } });
  });

  it("is written through someone else's account when the speaker isn't connected or can't reach it", async () => {
    const f = threeMembers(13);
    await tool(f.ann, f.phones[0], "create_family_calendar", {});

    g.calls.length = 0;
    await tool(f.cy, f.phones[2], "add_calendar_event", { title: "Dinner", start: "2026-10-26T19:00" });
    expect(callsTo("events.insert").map((c) => c.token)).toEqual(["ann-13"]);

    g.calls.length = 0;
    g.failures = [{ method: "events.insert", token: "bo-13", status: 404 }];
    const out = await tool(f.bo, f.phones[1], "add_calendar_event", { title: "Film", start: "2026-10-27T20:00" });
    expect(out.result).toContain("family calendar");
    expect(callsTo("events.insert").map((c) => c.token)).toEqual(["bo-13", "ann-13"]);
  });

  it("is listed once, not under every member it's shared with", async () => {
    const f = threeMembers(14);
    await tool(f.ann, f.phones[0], "create_family_calendar", {});
    g.calendars = [
      { id: "primary", primary: true, accessRole: "owner" },
      { id: FAMILY_ID, selected: true, accessRole: "writer", summary: "Family" },
    ];
    g.events = [{ id: "e1", summary: "BBQ", start: { dateTime: "2026-10-25T13:00:00+01:00" }, end: { dateTime: "2026-10-25T15:00:00+01:00" } }];
    g.calls.length = 0;

    const out = await tool(f.ann, f.phones[0], "list_calendar_events", { from: "2026-10-25", to: "2026-10-25" });
    expect(out.result).toContain('The family calendar, "Family"');
    const listed = callsTo("events.list").map((c) => c.params.calendarId);
    expect(listed.filter((id) => id === FAMILY_ID)).toHaveLength(1);
    expect(listed.filter((id) => id === "primary")).toHaveLength(2); // Ann's and Bo's own
  });

  it("is shared with members who connect Google later", async () => {
    const f = threeMembers(15);
    await tool(f.ann, f.phones[0], "create_family_calendar", {});
    g.calls.length = 0;
    g.exchange.email = "cy@example.com";
    g.exchange.tokens.access_token = "cy-15";

    const app = express().use(cookieParser()).use(joyceGoogleRoutes);
    const start = await request(app).get(`/joyce/google/connect?t=${issueGoogleConnectToken(f.phones[2])}`);
    const state = new URL(start.headers.location).searchParams.get("state")!;
    const done = await request(app)
      .get(`/joyce/google/callback?code=abc&state=${state}`)
      .set("Cookie", start.headers["set-cookie"] as unknown as string[]);

    expect(done.text).toContain("shared calendar has been added");
    expect(callsTo("acl.insert")[0]).toMatchObject({
      token: "ann-15",
      params: { requestBody: { scope: { value: "cy@example.com" } } },
    });
    expect(callsTo("calendarList.insert")[0]).toMatchObject({ token: "cy-15" });
    g.exchange.email = "priya@example.com";
    g.exchange.tokens.access_token = "new-access";
  });

  it("is unshared from a member who leaves, and dropped if its owner leaves", async () => {
    const f = threeMembers(16);
    await tool(f.ann, f.phones[0], "create_family_calendar", {});
    g.calls.length = 0;

    requestLeave(f.phones[1]);
    await composeReply(f.phones[1], "confirm cancel");
    expect(callsTo("acl.delete")[0]).toMatchObject({
      token: "ann-16",
      params: { calendarId: FAMILY_ID, ruleId: "user:bo@example.com" },
    });
    expect(getFamilyCalendar(f.ann)).not.toBeNull();

    requestLeave(f.phones[0]);
    await composeReply(f.phones[0], "confirm cancel");
    expect(getFamilyCalendar(openFamilySessionForPhone(f.phones[2])!)).toBeNull();
  });
});

describe("time handling", () => {
  it("finds local midnight across clock changes", () => {
    expect(startOfDayIn("2026-07-01", "Europe/London").toISOString()).toBe("2026-06-30T23:00:00.000Z");
    expect(startOfDayIn("2026-12-01", "Europe/London").toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(startOfDayIn("2026-12-01", "America/New_York").toISOString()).toBe("2026-12-01T05:00:00.000Z");
    expect(startOfDayIn("2026-12-01", "Asia/Kolkata").toISOString()).toBe("2026-11-30T18:30:00.000Z");
  });

  it("rejects malformed or backwards times", () => {
    expect(typeof eventTimes("tomorrow 3pm", undefined, "UTC")).toBe("string");
    expect(typeof eventTimes("2026-10-20T15:00", "2026-10-20T14:00", "UTC")).toBe("string");
    expect(eventTimes("2026-10-20", "2026-10-22", "UTC")).toEqual({
      start: { date: "2026-10-20" },
      end: { date: "2026-10-23" },
    });
  });
});

describe("the connect pages", () => {
  const app = express().use(cookieParser()).use(joyceGoogleRoutes);

  async function startConnect(token: string) {
    const res = await request(app).get(`/joyce/google/connect?t=${token}`);
    const state = new URL(res.headers.location).searchParams.get("state")!;
    const cookie = res.headers["set-cookie"] as unknown as string[];
    return { res, state, cookie };
  }

  it("connect the account to the family the link belongs to", async () => {
    const { session } = familyOf("15553330030", "Sam");
    const { res, state, cookie } = await startConnect(issueGoogleConnectToken("15553330030"));
    expect(res.status).toBe(302);

    const done = await request(app).get(`/joyce/google/callback?code=abc&state=${state}`).set("Cookie", cookie);
    expect(done.status).toBe(200);
    expect(done.text).toContain("priya@example.com");
    const [acct] = listGoogleAccounts(session);
    expect(acct).toMatchObject({ email: "priya@example.com", isSelf: true, timeZone: "Europe/London", refreshToken: "new-refresh" });
  });

  it("refuse to finish in a browser that didn't start it", async () => {
    const { session } = familyOf("15553330031", "Tia");
    const { state } = await startConnect(issueGoogleConnectToken("15553330031"));
    const done = await request(app).get(`/joyce/google/callback?code=abc&state=${state}`);
    expect(done.status).toBe(400);
    expect(listGoogleAccounts(session)).toEqual([]);
  });

  it("leave the link working if they cancel on Google's screen", async () => {
    familyOf("15553330032", "Uma");
    const token = issueGoogleConnectToken("15553330032");
    const { state, cookie } = await startConnect(token);
    const done = await request(app).get(`/joyce/google/callback?error=access_denied&state=${state}`).set("Cookie", cookie);
    expect(done.text).toContain("Nothing was connected");
    expect(isGoogleConnectTokenLive(token)).toBe(true);
  });

  it("reject a dead link before sending anyone to Google", async () => {
    const res = await request(app).get(`/joyce/google/connect?t=not-a-real-token`);
    expect(res.status).toBe(410);
  });
});
