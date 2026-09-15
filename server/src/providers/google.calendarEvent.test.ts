// Regression coverage for a real bug: calendar events for something happening outside the
// user's home timezone (a flight, a trip abroad) were created with no explicit timeZone at all,
// so Google Calendar fell back to the calendar's own default (home) timezone instead of the
// event's real local time. See microsoft.calendarEvent.test.ts for the Microsoft-side equivalent.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AccountRow } from "../db/store.js";

const { mockInsert, mockPatch } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockPatch: vi.fn(),
}));

vi.mock("../db/store.js", () => ({
  updateAccountTokens: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
        on() {}
      },
    },
    calendar: () => ({ events: { insert: mockInsert, patch: mockPatch } }),
  },
}));

const { googleCreateEvent, googleUpdateEvent } = await import("./google.js");

function fakeAccount(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 1,
    ownerId: 1,
    provider: "google",
    email: "test@example.com",
    accessToken: "fake-access-token",
    refreshToken: "fake-refresh-token",
    expiryDate: Date.now() + 60 * 60 * 1000,
    authBroken: false,
    authBrokenAt: null,
    canRead: true,
    canSend: true,
    canDelete: true,
    historyId: null,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  mockInsert.mockReset().mockResolvedValue({ data: { id: "evt-1" } });
  mockPatch.mockReset().mockResolvedValue({ data: { id: "evt-1" } });
});

describe("googleCreateEvent", () => {
  it("passes the caller's start/end timezone through instead of leaving it unset", async () => {
    await googleCreateEvent(fakeAccount(), {
      title: "Flight to Lima",
      start: "2026-09-19T17:29:00",
      end: "2026-09-19T20:35:00",
      startTimeZone: "America/Bogota",
      endTimeZone: "America/Lima",
    });

    const [requestBody] = mockInsert.mock.calls[0];
    expect(requestBody.requestBody.start).toEqual({
      dateTime: "2026-09-19T17:29:00",
      timeZone: "America/Bogota",
    });
    expect(requestBody.requestBody.end).toEqual({
      dateTime: "2026-09-19T20:35:00",
      timeZone: "America/Lima",
    });
  });

  it("omits timeZone when none is given, unchanged from before", async () => {
    await googleCreateEvent(fakeAccount(), {
      title: "Dentist",
      start: "2026-09-19T09:00:00Z",
      end: "2026-09-19T09:30:00Z",
    });

    const [requestBody] = mockInsert.mock.calls[0];
    expect(requestBody.requestBody.start).toEqual({ dateTime: "2026-09-19T09:00:00Z" });
    expect(requestBody.requestBody.end).toEqual({ dateTime: "2026-09-19T09:30:00Z" });
  });
});

describe("googleUpdateEvent", () => {
  it("passes an updated timezone through when start/end are being changed", async () => {
    await googleUpdateEvent(fakeAccount(), "evt-1", {
      start: "2026-09-19T18:00:00",
      end: "2026-09-19T21:00:00",
      startTimeZone: "America/Bogota",
      endTimeZone: "America/Lima",
    });

    const [requestBody] = mockPatch.mock.calls[0];
    expect(requestBody.requestBody.start).toEqual({
      dateTime: "2026-09-19T18:00:00",
      timeZone: "America/Bogota",
    });
    expect(requestBody.requestBody.end).toEqual({
      dateTime: "2026-09-19T21:00:00",
      timeZone: "America/Lima",
    });
  });
});
