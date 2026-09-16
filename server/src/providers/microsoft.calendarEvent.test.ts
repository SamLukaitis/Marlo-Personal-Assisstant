// Regression coverage for a real bug: calendar events for something happening outside the
// user's home timezone (a flight, a trip abroad) were always tagged "UTC" on Microsoft Graph
// regardless of where the event actually was, so viewers always saw it converted to their own
// home timezone instead of the event's real local time. See google.calendarEvent.test.ts for the
// Google-side equivalent.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AccountRow } from "../db/store.js";

vi.mock("../db/store.js", () => ({
  updateAccountTokens: vi.fn(),
}));

const { microsoftCreateEvent, microsoftUpdateEvent, microsoftListEvents } = await import("./microsoft.js");

function fakeAccount(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 1,
    ownerId: 1,
    provider: "microsoft",
    email: "test@example.com",
    accessToken: "fake-access-token",
    refreshToken: "fake-refresh-token",
    expiryDate: Date.now() + 60 * 60 * 1000, // valid — accessTokenFor never needs to refresh
    authBroken: false,
    authBrokenAt: null,
    canRead: true,
    canSend: true,
    canDelete: true,
    historyId: null,
    ...overrides,
  };
}

function mockGraphResponse(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("microsoftCreateEvent", () => {
  it("passes the caller's start/end timezone through to Graph instead of hardcoding UTC", async () => {
    vi.mocked(fetch).mockResolvedValue(mockGraphResponse({ id: "evt-1" }));

    await microsoftCreateEvent(fakeAccount(), {
      title: "Flight to Lima",
      start: "2026-09-19T17:29:00",
      end: "2026-09-19T20:35:00",
      startTimeZone: "America/Bogota",
      endTimeZone: "America/Lima",
    });

    const [, requestInit] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(requestInit!.body as string);
    expect(body.start).toEqual({ dateTime: "2026-09-19T17:29:00", timeZone: "America/Bogota" });
    expect(body.end).toEqual({ dateTime: "2026-09-19T20:35:00", timeZone: "America/Lima" });
  });

  it("defaults to UTC when no timezone is given, unchanged from before", async () => {
    vi.mocked(fetch).mockResolvedValue(mockGraphResponse({ id: "evt-2" }));

    await microsoftCreateEvent(fakeAccount(), {
      title: "Dentist",
      start: "2026-09-19T09:00:00Z",
      end: "2026-09-19T09:30:00Z",
    });

    const [, requestInit] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(requestInit!.body as string);
    expect(body.start.timeZone).toBe("UTC");
    expect(body.end.timeZone).toBe("UTC");
  });
});

describe("microsoftUpdateEvent", () => {
  it("passes an updated timezone through when start/end are being changed", async () => {
    vi.mocked(fetch).mockResolvedValue(mockGraphResponse({ id: "evt-3" }));

    await microsoftUpdateEvent(fakeAccount(), "evt-3", {
      start: "2026-09-19T18:00:00",
      end: "2026-09-19T21:00:00",
      startTimeZone: "America/Bogota",
      endTimeZone: "America/Lima",
    });

    const [, requestInit] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(requestInit!.body as string);
    expect(body.start).toEqual({ dateTime: "2026-09-19T18:00:00", timeZone: "America/Bogota" });
    expect(body.end).toEqual({ dateTime: "2026-09-19T21:00:00", timeZone: "America/Lima" });
  });
});

// Graph returns event times in UTC but with no zone marker ("2026-09-15T09:00:00.0000000"), and
// everything downstream (the client, findFreeSlots, the briefing, the model) parsed that as local
// time — so an Outlook event showed at the wrong hour anywhere the server/user wasn't on UTC.
describe("microsoftListEvents", () => {
  it("asks Graph for UTC and returns times with an explicit UTC marker", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockGraphResponse({
        value: [
          {
            id: "evt-utc",
            subject: "Standup",
            isAllDay: false,
            start: { dateTime: "2026-09-15T09:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-09-15T09:30:00.0000000", timeZone: "UTC" },
          },
        ],
      })
    );

    const [event] = await microsoftListEvents(fakeAccount(), 7);

    expect(new Date(event.start).getTime()).toBe(Date.UTC(2026, 8, 15, 9, 0));
    expect(new Date(event.end).getTime()).toBe(Date.UTC(2026, 8, 15, 9, 30));
    expect(event.start).toMatch(/Z$/);
    const [, requestInit] = vi.mocked(fetch).mock.calls[0];
    expect((requestInit!.headers as Record<string, string>).Prefer).toBe('outlook.timezone="UTC"');
  });

  it("returns an all-day event as plain dates, flagged all-day, like Google does", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockGraphResponse({
        value: [
          {
            id: "evt-allday",
            subject: "Bank holiday",
            isAllDay: true,
            start: { dateTime: "2026-09-15T00:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-09-16T00:00:00.0000000", timeZone: "UTC" },
          },
        ],
      })
    );

    const [event] = await microsoftListEvents(fakeAccount(), 7);

    expect(event).toMatchObject({ start: "2026-09-15", end: "2026-09-16", allDay: true });
  });
});
