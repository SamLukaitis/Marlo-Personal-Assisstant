# App Hand-off Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one always-on tool, `make_app_link`, that returns a link opening Uber, Lyft, Google Maps, OpenTable, Resy, Spotify, Airbnb or Booking.com already filled in.

**Architecture:** A pure module, `server/src/services/appLinks.ts`, checks the model's raw tool input and builds a URL on a fixed host for each app. `assistant.ts` adds one pinned tool definition to `ALWAYS_ON_TOOLS`, a `runTool` case that calls `makeAppLink(input, { today })`, and one system-prompt rule. There's no network I/O, no env vars and no DB changes.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest, the WHATWG `URL`/`URLSearchParams` built-ins, and `luxon` (already a dependency) for date checks.

**Spec:** `docs/superpowers/specs/2026-10-12-app-handoff-links-design.md`

## Global Constraints

- The tool is always offered, with no env key, so the cached tools prefix stays constant.
- `make_app_link` is NOT added to `CONFIRM_REQUIRED_TOOLS`.
- Each builder only ever produces its own fixed host; model input is always URL-encoded and never builds the host or path prefix.
- Party size and guests: integers from 1 to 20. Dates: `YYYY-MM-DD`, today or later in the user's local date. Check-out is after check-in. Time: `HH:MM`, 24-hour.
- An omitted ride or directions origin means "current location".
- Marlowe never claims something is booked, ordered or playing. When the user wants the booking completed, it calls `flag_unmet_request`.
- The existing Google Maps search-link rule for recommended places stays unchanged.
- Repo docs rule (`CLAUDE.md`): add a changelog entry and update the README when the feature lands.

## Review Focus

1. **A place with only a name, no address or coordinates** (e.g. "Dishoom Shoreditch"): Uber, Google Maps and OpenTable should still build a link from the text. Only Lyft, which needs coordinates, should refuse, with a message pointing to Uber or Maps. The test is in Task 1.
2. **Half a coordinate pair, or out-of-range coordinates** (lat 200, or lat without lng): return an error rather than a broken link. The test is in Task 1.
3. **"Tonight" / today's date in the user's timezone**: today must be accepted, using the user's local date and not the server's UTC date. The test is in Task 2 (the boundary) and the handler test in Task 3 (wiring `userLocalClock`).
4. **Numbers sent as strings** (`"party_size": "4"`): the model sometimes sends numeric strings. Accept a whole number written as a string and reject `"four"` or `4.5`. The test is in Task 2.
5. **Very long or control-character text** (pasted paragraphs, newlines): trim to 200 characters and strip control characters, so links stay usable. The test is in Task 1.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/services/appLinks.ts` (create) | Parse and check raw tool input, and build each app's URL. Pure. |
| `server/src/services/appLinks.test.ts` (create) | Exact-URL, validation and hostile-input tests. |
| `server/src/ai/assistant.ts` (modify) | Tool definition, `runTool` case, system-prompt rule. |
| `server/src/ai/assistant.test.ts` (modify) | Tool always present; handler pass-through; prompt rule present. |
| `README.md`, `changelog/2026-10-12-app-handoff-links.md` | Docs (Task 4). |

---

### Task 1: `appLinks.ts` core: input parsing, rides and directions

**Files:**
- Create: `server/src/services/appLinks.ts`
- Test: `server/src/services/appLinks.test.ts`

**Interfaces:**
- Produces:
  - `export type AppName = "uber" | "lyft" | "google_maps" | "opentable" | "resy" | "spotify" | "airbnb" | "booking_com"`
  - `export const APP_NAMES: readonly AppName[]`
  - `export type AppLinkResult = { url: string; label: string } | { error: string }`
  - `export function makeAppLink(raw: Record<string, unknown>, ctx: { today: string }): AppLinkResult`. `ctx.today` is `YYYY-MM-DD`.
  - Raw input keys (snake_case, same as the tool schema): `app`, `origin`, `destination` (each `{ name?, address?, latitude?, longitude? }`), `travel_mode`, `query`, `city`, `party_size`, `date`, `time`, `check_in`, `check_out`, `guests`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/services/appLinks.test.ts
import { describe, it, expect } from "vitest";
import { makeAppLink } from "./appLinks.js";

const ctx = { today: "2026-10-12" };

function ok(result: ReturnType<typeof makeAppLink>): { url: string; label: string } {
  if ("error" in result) throw new Error(`expected a link, got error: ${result.error}`);
  return result;
}
function err(result: ReturnType<typeof makeAppLink>): string {
  if (!("error" in result)) throw new Error(`expected an error, got ${result.url}`);
  return result.error;
}

describe("makeAppLink — input", () => {
  it("rejects an unknown app", () => {
    expect(err(makeAppLink({ app: "doordash" }, ctx))).toMatch(/app/i);
  });

  it("rejects a half coordinate pair", () => {
    expect(err(makeAppLink({ app: "uber", destination: { latitude: 51.5 } }, ctx))).toMatch(/latitude and longitude/i);
  });

  it("rejects out-of-range coordinates", () => {
    expect(err(makeAppLink({ app: "uber", destination: { latitude: 200, longitude: 0 } }, ctx))).toMatch(/coordinates/i);
  });

  it("strips control characters and caps text at 200 chars", () => {
    const long = "a".repeat(300);
    const { url } = ok(makeAppLink({ app: "spotify", query: `chill\nvibes\u0000${long}` }, ctx));
    const q = decodeURIComponent(new URL(url).pathname.replace("/search/", ""));
    expect(q).not.toMatch(/[\u0000-\u001f]/);
    expect(q.length).toBe(200);
    expect(q.startsWith("chill vibes")).toBe(true);
  });

  it("encodes a dot-only path segment so the URL parser can't resolve it away", () => {
    const { url } = ok(makeAppLink({ app: "spotify", query: ".." }, ctx));
    expect(new URL(url).pathname).toBe("/search/%2E%2E");
  });
});

describe("makeAppLink — uber", () => {
  it("defaults pickup to current location and uses a text-only drop-off", () => {
    const { url, label } = ok(makeAppLink({ app: "uber", destination: { name: "Dishoom Shoreditch" } }, ctx));
    expect(label).toBe("Open in Uber");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://m.uber.com/ul/");
    expect(u.searchParams.get("action")).toBe("setPickup");
    expect(u.searchParams.get("pickup")).toBe("my_location");
    expect(u.searchParams.get("dropoff[nickname]")).toBe("Dishoom Shoreditch");
    expect(u.searchParams.get("dropoff[formatted_address]")).toBe("Dishoom Shoreditch");
  });

  it("uses coordinates and address when given", () => {
    const { url } = ok(
      makeAppLink(
        {
          app: "uber",
          origin: { latitude: 51.52, longitude: -0.08 },
          destination: { name: "Heathrow T5", address: "Wallis Rd, Hounslow TW6 2GA", latitude: 51.47, longitude: -0.49 },
        },
        ctx
      )
    );
    const u = new URL(url);
    expect(u.searchParams.get("pickup[latitude]")).toBe("51.52");
    expect(u.searchParams.get("pickup[longitude]")).toBe("-0.08");
    expect(u.searchParams.get("pickup")).toBeNull();
    expect(u.searchParams.get("dropoff[latitude]")).toBe("51.47");
    expect(u.searchParams.get("dropoff[formatted_address]")).toBe("Wallis Rd, Hounslow TW6 2GA");
    expect(u.searchParams.get("dropoff[nickname]")).toBe("Heathrow T5");
  });

  it("requires a destination", () => {
    expect(err(makeAppLink({ app: "uber" }, ctx))).toMatch(/destination/i);
  });

  it("keeps the host fixed and the hostile text inside one encoded value", () => {
    const evil = "x&action=evil#frag javascript:alert(1)";
    const { url } = ok(makeAppLink({ app: "uber", destination: { name: evil } }, ctx));
    const u = new URL(url);
    expect(u.host).toBe("m.uber.com");
    expect(u.hash).toBe("");
    expect(u.searchParams.getAll("action")).toEqual(["setPickup"]);
    expect(u.searchParams.get("dropoff[nickname]")).toBe(evil);
  });
});

describe("makeAppLink — lyft", () => {
  it("builds a link from coordinates", () => {
    const { url, label } = ok(
      makeAppLink({ app: "lyft", origin: { latitude: 40.74, longitude: -73.99 }, destination: { latitude: 40.64, longitude: -73.78 } }, ctx)
    );
    expect(label).toBe("Open in Lyft");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://lyft.com/ride");
    expect(u.searchParams.get("id")).toBe("lyft");
    expect(u.searchParams.get("pickup[latitude]")).toBe("40.74");
    expect(u.searchParams.get("destination[longitude]")).toBe("-73.78");
  });

  it("omits pickup (current location) when no origin", () => {
    const { url } = ok(makeAppLink({ app: "lyft", destination: { latitude: 40.64, longitude: -73.78 } }, ctx));
    expect(new URL(url).searchParams.get("pickup[latitude]")).toBeNull();
  });

  it("refuses a text-only destination and points to Uber or Maps", () => {
    expect(err(makeAppLink({ app: "lyft", destination: { name: "JFK" } }, ctx))).toMatch(/coordinates.*uber|google_maps/i);
  });
});

describe("makeAppLink — google_maps", () => {
  it("builds directions from current location by default", () => {
    const { url, label } = ok(makeAppLink({ app: "google_maps", destination: { name: "Borough Market" } }, ctx));
    expect(label).toBe("Open in Google Maps");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://www.google.com/maps/dir/");
    expect(u.searchParams.get("api")).toBe("1");
    expect(u.searchParams.get("destination")).toBe("Borough Market");
    expect(u.searchParams.get("origin")).toBeNull();
  });

  it("prefers coordinates, and maps travel_mode", () => {
    const { url } = ok(
      makeAppLink(
        { app: "google_maps", origin: { name: "Home", latitude: 51.5, longitude: -0.1 }, destination: { address: "1 Main St" }, travel_mode: "transit" },
        ctx
      )
    );
    const u = new URL(url);
    expect(u.searchParams.get("origin")).toBe("51.5,-0.1");
    expect(u.searchParams.get("travelmode")).toBe("transit");
  });

  it("rejects an unknown travel_mode, including Object.prototype keys", () => {
    expect(err(makeAppLink({ app: "google_maps", destination: { name: "X" }, travel_mode: "teleport" }, ctx))).toMatch(/travel_mode/);
    expect(err(makeAppLink({ app: "google_maps", destination: { name: "X" }, travel_mode: "constructor" }, ctx))).toMatch(/travel_mode/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/services/appLinks.test.ts`
Expected: FAIL. The import fails because `./appLinks.js` doesn't exist.

- [ ] **Step 3: Write the implementation**

```ts
// server/src/services/appLinks.ts
// Hand-off links for apps that don't let us act for a user (Uber, OpenTable, Spotify, …): Marlowe
// builds a link that opens the app already filled in and the user confirms there. Pure — no I/O —
// so every URL format lives here and is pinned by appLinks.test.ts. Each builder starts from its
// own fixed host; model input only ever goes in through URLSearchParams/encodeURIComponent, so it
// can't redirect the link anywhere else. See docs/superpowers/specs/2026-10-12-app-handoff-links-design.md.

export type AppName = "uber" | "lyft" | "google_maps" | "opentable" | "resy" | "spotify" | "airbnb" | "booking_com";
export const APP_NAMES: readonly AppName[] = ["uber", "lyft", "google_maps", "opentable", "resy", "spotify", "airbnb", "booking_com"];

export type AppLinkResult = { url: string; label: string } | { error: string };

interface Place {
  name?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
}

interface Ctx {
  today: string;
}

const MAX_TEXT = 200;
const TRAVEL_MODES: Record<string, string> = { drive: "driving", walk: "walking", transit: "transit", bike: "bicycling" };

class InputError extends Error {}

function text(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new InputError(`${field} must be text.`);
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  return cleaned || undefined;
}

function requiredText(value: unknown, field: string): string {
  const t = text(value, field);
  if (!t) throw new InputError(`${field} is required for this app.`);
  return t;
}

function coordinate(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : NaN;
}

function place(value: unknown, field: string): Place | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw new InputError(`${field} must be an object with name/address/latitude/longitude.`);
  const raw = value as Record<string, unknown>;
  const latitude = coordinate(raw.latitude);
  const longitude = coordinate(raw.longitude);
  if ((latitude === undefined) !== (longitude === undefined)) {
    throw new InputError(`${field} needs both latitude and longitude, or neither.`);
  }
  if (latitude !== undefined && longitude !== undefined) {
    if (Number.isNaN(latitude) || Number.isNaN(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      throw new InputError(`${field} has invalid coordinates.`);
    }
  }
  const p: Place = { name: text(raw.name, `${field}.name`), address: text(raw.address, `${field}.address`), latitude, longitude };
  if (!p.name && !p.address && p.latitude === undefined) return undefined;
  return p;
}

// One URL path segment from model text. encodeURIComponent leaves "." alone, and a bare ".."
// segment would be resolved by the URL parser into a different path, so dots are encoded too.
function pathSegment(value: string): string {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}

function hasCoords(p: Place): p is Place & { latitude: number; longitude: number } {
  return p.latitude !== undefined && p.longitude !== undefined;
}

function placeText(p: Place): string | undefined {
  return [p.name, p.address].filter(Boolean).join(", ") || undefined;
}

function requiredDestination(raw: Record<string, unknown>): Place {
  const p = place(raw.destination, "destination");
  if (!p) throw new InputError("destination is required (a name, address or coordinates).");
  return p;
}

function uber(raw: Record<string, unknown>): AppLinkResult {
  const origin = place(raw.origin, "origin");
  const dest = requiredDestination(raw);
  const u = new URL("https://m.uber.com/ul/");
  u.searchParams.set("action", "setPickup");
  if (!origin) {
    u.searchParams.set("pickup", "my_location");
  } else {
    setUberPlace(u, "pickup", origin);
  }
  setUberPlace(u, "dropoff", dest);
  return { url: u.toString(), label: "Open in Uber" };
}

function setUberPlace(u: URL, prefix: "pickup" | "dropoff", p: Place): void {
  if (hasCoords(p)) {
    u.searchParams.set(`${prefix}[latitude]`, String(p.latitude));
    u.searchParams.set(`${prefix}[longitude]`, String(p.longitude));
  }
  const nickname = p.name ?? p.address;
  const address = p.address ?? p.name;
  if (nickname) u.searchParams.set(`${prefix}[nickname]`, nickname);
  if (address) u.searchParams.set(`${prefix}[formatted_address]`, address);
}

function lyft(raw: Record<string, unknown>): AppLinkResult {
  const origin = place(raw.origin, "origin");
  const dest = requiredDestination(raw);
  if (!hasCoords(dest) || (origin && !hasCoords(origin))) {
    throw new InputError("Lyft links need coordinates for each place. Use uber or google_maps for a place you only have a name or address for.");
  }
  const u = new URL("https://lyft.com/ride");
  u.searchParams.set("id", "lyft");
  if (origin && hasCoords(origin)) {
    u.searchParams.set("pickup[latitude]", String(origin.latitude));
    u.searchParams.set("pickup[longitude]", String(origin.longitude));
  }
  u.searchParams.set("destination[latitude]", String(dest.latitude));
  u.searchParams.set("destination[longitude]", String(dest.longitude));
  return { url: u.toString(), label: "Open in Lyft" };
}

function mapsPoint(p: Place): string {
  return hasCoords(p) ? `${p.latitude},${p.longitude}` : (placeText(p) as string);
}

function googleMaps(raw: Record<string, unknown>): AppLinkResult {
  const origin = place(raw.origin, "origin");
  const dest = requiredDestination(raw);
  const mode = text(raw.travel_mode, "travel_mode");
  if (mode && !Object.hasOwn(TRAVEL_MODES, mode)) throw new InputError(`travel_mode must be one of: ${Object.keys(TRAVEL_MODES).join(", ")}.`);
  const u = new URL("https://www.google.com/maps/dir/");
  u.searchParams.set("api", "1");
  if (origin) u.searchParams.set("origin", mapsPoint(origin));
  u.searchParams.set("destination", mapsPoint(dest));
  if (mode) u.searchParams.set("travelmode", TRAVEL_MODES[mode]);
  return { url: u.toString(), label: "Open in Google Maps" };
}

function spotify(raw: Record<string, unknown>): AppLinkResult {
  const query = requiredText(raw.query, "query");
  return { url: `https://open.spotify.com/search/${pathSegment(query)}`, label: "Open in Spotify" };
}

// Task 2 adds opentable, resy, airbnb and booking_com to this table.
const BUILDERS: Partial<Record<AppName, (raw: Record<string, unknown>, ctx: Ctx) => AppLinkResult>> = {
  uber,
  lyft,
  google_maps: googleMaps,
  spotify,
};

export function makeAppLink(raw: Record<string, unknown>, ctx: Ctx): AppLinkResult {
  const app = raw.app as AppName;
  const build = APP_NAMES.includes(app) ? BUILDERS[app] : undefined;
  if (!build) return { error: `app must be one of: ${APP_NAMES.join(", ")}.` };
  try {
    return build(raw, ctx);
  } catch (e) {
    if (e instanceof InputError) return { error: e.message };
    throw e;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/services/appLinks.test.ts`
Expected: all PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
cd server && npx tsc -p tsconfig.json --noEmit
git add server/src/services/appLinks.ts server/src/services/appLinks.test.ts
git commit -m "feat: appLinks builder for Uber, Lyft, Google Maps and Spotify hand-off links"
```

---

### Task 2: Bookings and stays: OpenTable, Resy, Airbnb, Booking.com

**Files:**
- Modify: `server/src/services/appLinks.ts`
- Test: `server/src/services/appLinks.test.ts`

**Interfaces:**
- Consumes: the `text`, `requiredText`, `InputError`, `BUILDERS` and `Ctx` internals from Task 1 (same file).
- Produces: no new exports. `makeAppLink` now accepts `opentable`, `resy`, `airbnb` and `booking_com`.

- [ ] **Step 1: Write the failing tests** (append to `appLinks.test.ts`)

```ts
describe("makeAppLink — opentable", () => {
  it("builds a search with covers and date-time", () => {
    const { url, label } = ok(
      makeAppLink({ app: "opentable", query: "Dishoom Shoreditch", party_size: 4, date: "2026-10-16", time: "20:00" }, ctx)
    );
    expect(label).toBe("Open in OpenTable");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://www.opentable.com/s");
    expect(u.searchParams.get("term")).toBe("Dishoom Shoreditch");
    expect(u.searchParams.get("covers")).toBe("4");
    expect(u.searchParams.get("dateTime")).toBe("2026-10-16T20:00");
  });

  it("accepts today (the user's local date) and a whole number sent as a string", () => {
    const { url } = ok(makeAppLink({ app: "opentable", query: "X", party_size: "2", date: "2026-10-12", time: "19:30" }, ctx));
    expect(new URL(url).searchParams.get("covers")).toBe("2");
  });

  it("rejects a past date, a bad time, and out-of-range or non-integer party sizes", () => {
    expect(err(makeAppLink({ app: "opentable", query: "X", date: "2026-10-11" }, ctx))).toMatch(/past/i);
    expect(err(makeAppLink({ app: "opentable", query: "X", date: "2026-10-16", time: "8pm" }, ctx))).toMatch(/time/i);
    expect(err(makeAppLink({ app: "opentable", query: "X", party_size: 0 }, ctx))).toMatch(/party_size/);
    expect(err(makeAppLink({ app: "opentable", query: "X", party_size: 21 }, ctx))).toMatch(/party_size/);
    expect(err(makeAppLink({ app: "opentable", query: "X", party_size: 4.5 }, ctx))).toMatch(/party_size/);
    expect(err(makeAppLink({ app: "opentable", query: "X", party_size: "four" }, ctx))).toMatch(/party_size/);
  });

  it("rejects a time without a date", () => {
    expect(err(makeAppLink({ app: "opentable", query: "X", time: "20:00" }, ctx))).toMatch(/date/i);
  });

  it("requires a query", () => {
    expect(err(makeAppLink({ app: "opentable" }, ctx))).toMatch(/query/);
  });
});

describe("makeAppLink — resy", () => {
  it("slugs the city and sets date, seats and query", () => {
    const { url, label } = ok(makeAppLink({ app: "resy", city: "New York, NY", query: "Carbone", party_size: 2, date: "2026-10-20" }, ctx));
    expect(label).toBe("Open in Resy");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://resy.com/cities/new-york-ny");
    expect(u.searchParams.get("date")).toBe("2026-10-20");
    expect(u.searchParams.get("seats")).toBe("2");
    expect(u.searchParams.get("query")).toBe("Carbone");
  });

  it("requires a city", () => {
    expect(err(makeAppLink({ app: "resy", query: "Carbone" }, ctx))).toMatch(/city/);
  });

  it("rejects a city that slugs to nothing", () => {
    expect(err(makeAppLink({ app: "resy", city: "!!!" }, ctx))).toMatch(/city/);
  });
});

describe("makeAppLink — airbnb", () => {
  it("builds a homes search with dates and adults", () => {
    const { url, label } = ok(makeAppLink({ app: "airbnb", city: "Lisbon, Portugal", check_in: "2026-11-03", check_out: "2026-11-06", guests: 2 }, ctx));
    expect(label).toBe("Open in Airbnb");
    const u = new URL(url);
    expect(u.host).toBe("www.airbnb.com");
    expect(decodeURIComponent(u.pathname)).toBe("/s/Lisbon, Portugal/homes");
    expect(u.searchParams.get("checkin")).toBe("2026-11-03");
    expect(u.searchParams.get("checkout")).toBe("2026-11-06");
    expect(u.searchParams.get("adults")).toBe("2");
  });

  it("keeps a slash in the location inside one path segment", () => {
    const { url } = ok(makeAppLink({ app: "airbnb", city: "../../evil/path" }, ctx));
    const u = new URL(url);
    expect(u.host).toBe("www.airbnb.com");
    expect(u.pathname.startsWith("/s/")).toBe(true);
    expect(u.pathname.endsWith("/homes")).toBe(true);
    expect(u.pathname.split("/").length).toBe(4); // "", "s", <one encoded segment>, "homes"
  });

  it("rejects check-out on or before check-in", () => {
    expect(err(makeAppLink({ app: "airbnb", city: "Lisbon", check_in: "2026-11-06", check_out: "2026-11-06" }, ctx))).toMatch(/check_out/);
  });

  it("rejects only one of check_in/check_out", () => {
    expect(err(makeAppLink({ app: "airbnb", city: "Lisbon", check_in: "2026-11-06" }, ctx))).toMatch(/check_in and check_out/);
  });
});

describe("makeAppLink — booking_com", () => {
  it("builds a search with dates, adults and one room", () => {
    const { url, label } = ok(makeAppLink({ app: "booking_com", city: "Lisbon", check_in: "2026-11-03", check_out: "2026-11-06", guests: 3 }, ctx));
    expect(label).toBe("Open in Booking.com");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://www.booking.com/searchresults.html");
    expect(u.searchParams.get("ss")).toBe("Lisbon");
    expect(u.searchParams.get("checkin")).toBe("2026-11-03");
    expect(u.searchParams.get("checkout")).toBe("2026-11-06");
    expect(u.searchParams.get("group_adults")).toBe("3");
    expect(u.searchParams.get("no_rooms")).toBe("1");
  });
});
```

Note: Airbnb, Booking.com and Resy all use the `city` field, the area to search. This is simpler than the spec's per-app `location`/`city` split, and it's one field fewer for the model to keep track of.

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd server && npx vitest run src/services/appLinks.test.ts`
Expected: the new tests FAIL with `app must be one of` errors (builders missing); the Task 1 tests still PASS.

- [ ] **Step 3: Implement.** In `appLinks.ts`, add `import { DateTime } from "luxon";` below the header comment, and add these above `BUILDERS`:

```ts
function count(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 20) {
    throw new InputError(`${field} must be a whole number from 1 to 20.`);
  }
  return n;
}

function date(value: unknown, field: string, ctx: Ctx): string | undefined {
  const t = text(value, field);
  if (!t) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || !DateTime.fromISO(t).isValid) throw new InputError(`${field} must be a date as YYYY-MM-DD.`);
  if (t < ctx.today) throw new InputError(`${field} is in the past (today is ${ctx.today}).`);
  return t;
}

function time(value: unknown): string | undefined {
  const t = text(value, "time");
  if (!t) return undefined;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new InputError("time must be 24-hour HH:MM, e.g. 20:00.");
  return t;
}

function stay(raw: Record<string, unknown>, ctx: Ctx): { city: string; checkIn?: string; checkOut?: string; guests?: number } {
  const city = requiredText(raw.city, "city");
  const checkIn = date(raw.check_in, "check_in", ctx);
  const checkOut = date(raw.check_out, "check_out", ctx);
  if ((checkIn === undefined) !== (checkOut === undefined)) throw new InputError("Give both check_in and check_out, or neither.");
  if (checkIn && checkOut && checkOut <= checkIn) throw new InputError("check_out must be after check_in.");
  return { city, checkIn, checkOut, guests: count(raw.guests, "guests") };
}

function opentable(raw: Record<string, unknown>, ctx: Ctx): AppLinkResult {
  const query = requiredText(raw.query, "query");
  const partySize = count(raw.party_size, "party_size");
  const d = date(raw.date, "date", ctx);
  const t = time(raw.time);
  if (t && !d) throw new InputError("Give a date with the time.");
  const u = new URL("https://www.opentable.com/s");
  u.searchParams.set("term", query);
  if (partySize) u.searchParams.set("covers", String(partySize));
  if (d) u.searchParams.set("dateTime", `${d}T${t ?? "19:00"}`);
  return { url: u.toString(), label: "Open in OpenTable" };
}

function resy(raw: Record<string, unknown>, ctx: Ctx): AppLinkResult {
  const city = requiredText(raw.city, "city");
  const slug = city.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new InputError("city must contain letters, e.g. 'New York, NY'.");
  const query = text(raw.query, "query");
  const seats = count(raw.party_size, "party_size");
  const d = date(raw.date, "date", ctx);
  const u = new URL(`https://resy.com/cities/${slug}`);
  if (d) u.searchParams.set("date", d);
  if (seats) u.searchParams.set("seats", String(seats));
  if (query) u.searchParams.set("query", query);
  return { url: u.toString(), label: "Open in Resy" };
}

function airbnb(raw: Record<string, unknown>, ctx: Ctx): AppLinkResult {
  const s = stay(raw, ctx);
  const u = new URL(`https://www.airbnb.com/s/${pathSegment(s.city)}/homes`);
  if (s.checkIn && s.checkOut) {
    u.searchParams.set("checkin", s.checkIn);
    u.searchParams.set("checkout", s.checkOut);
  }
  if (s.guests) u.searchParams.set("adults", String(s.guests));
  return { url: u.toString(), label: "Open in Airbnb" };
}

function bookingCom(raw: Record<string, unknown>, ctx: Ctx): AppLinkResult {
  const s = stay(raw, ctx);
  const u = new URL("https://www.booking.com/searchresults.html");
  u.searchParams.set("ss", s.city);
  if (s.checkIn && s.checkOut) {
    u.searchParams.set("checkin", s.checkIn);
    u.searchParams.set("checkout", s.checkOut);
  }
  if (s.guests) u.searchParams.set("group_adults", String(s.guests));
  u.searchParams.set("no_rooms", "1");
  return { url: u.toString(), label: "Open in Booking.com" };
}
```

Then replace the `BUILDERS` declaration (and its "Task 2 adds…" comment) with:

```ts
const BUILDERS: Record<AppName, (raw: Record<string, unknown>, ctx: Ctx) => AppLinkResult> = {
  uber,
  lyft,
  google_maps: googleMaps,
  opentable,
  resy,
  spotify,
  airbnb,
  booking_com: bookingCom,
};
```

`makeAppLink` needs no change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/services/appLinks.test.ts`
Expected: all PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
cd server && npx tsc -p tsconfig.json --noEmit
git add server/src/services/appLinks.ts server/src/services/appLinks.test.ts
git commit -m "feat: OpenTable, Resy, Airbnb and Booking.com hand-off links"
```

---

### Task 3: Wire `make_app_link` into the assistant

**Files:**
- Modify: `server/src/ai/assistant.ts`. Imports (near line 72), `ALWAYS_ON_TOOLS` (insert right after the `flag_unmet_request` definition, around line 742–752), `runTool` (right after `case "flag_unmet_request":`, around line 1523), and `buildRules` `base` array (around line 1972).
- Test: `server/src/ai/assistant.test.ts`

**Interfaces:**
- Consumes: `makeAppLink(raw, { today })` and `APP_NAMES` from `../services/appLinks.js`; `userLocalClock(ownerId).dateKey` from `../services/userTimezone.js` (already imported module; add the named import).
- Produces: a tool named `make_app_link`, always in `buildToolsForOwner(...)`.

- [ ] **Step 1: Write the failing tests** (append to `assistant.test.ts`; `findOrCreateUserByEmail`, `uniqueEmail`, `buildToolsForOwner`, `runTool`, `buildSystemPrompt` and `setUserTimezone` are already imported there)

```ts
describe("make_app_link", () => {
  it("is offered to every user with no env or toggles", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("applink-tool"));
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).toContain("make_app_link");
  });

  it("returns the built link", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("applink-run"));
    const result = await runTool(user.id, "make_app_link", { app: "spotify", query: "lofi beats" });
    expect(result).toEqual({ url: "https://open.spotify.com/search/lofi%20beats", label: "Open in Spotify" });
  });

  it("returns validation errors to the model rather than throwing", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("applink-err"));
    const result = (await runTool(user.id, "make_app_link", { app: "opentable" })) as { error?: string };
    expect(result.error).toMatch(/query/);
  });

  it("judges 'today' by the user's own timezone", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("applink-tz"));
    setUserTimezone(user.id, "Pacific/Kiritimati"); // UTC+14: usually already 'tomorrow' vs the server
    const { DateTime } = await import("luxon");
    const localToday = DateTime.now().setZone("Pacific/Kiritimati").toFormat("yyyy-MM-dd");
    const result = (await runTool(user.id, "make_app_link", { app: "opentable", query: "X", date: localToday })) as { url?: string };
    expect(result.url).toContain(`dateTime=${localToday}T19%3A00`);
  });

  it("system prompt tells the model to use make_app_link and never claim a booking", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("applink-prompt"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("make_app_link");
    expect(prompt).toMatch(/never (say|claim).*(booked|ordered|playing)/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/ai/assistant.test.ts -t make_app_link`
Expected: FAIL. `make_app_link` isn't in the tools list, and `runTool` returns an unknown-tool result.

- [ ] **Step 3: Implement**

Imports in `assistant.ts`: change the existing line
`import { resolveUserTimezone } from "../services/userTimezone.js";`
to
`import { resolveUserTimezone, userLocalClock } from "../services/userTimezone.js";`
and add
`import { makeAppLink, APP_NAMES } from "../services/appLinks.js";`

Tool definition, inserted into `ALWAYS_ON_TOOLS` directly after the `flag_unmet_request` object:

```ts
  {
    name: "make_app_link",
    description:
      "Make a link that opens an app already filled in, for things you can't do yourself: rides (uber, lyft), directions (google_maps), restaurant tables (opentable, resy), music (spotify) and stays (airbnb, booking_com). The user taps it and confirms in that app — you have NOT booked, ordered or started anything, so never say you have. " +
      "Fields per app: uber/google_maps — destination (required), origin (omit for the user's current location), google_maps also travel_mode. lyft — same, but every place needs latitude+longitude (from a recent location pin or a places result; never invent coordinates — if you only have a name, use uber or google_maps). " +
      "opentable — query (restaurant name + area, required), party_size, date, time. resy — city (required, e.g. 'New York, NY'), query, party_size, date. spotify — query (song, artist, playlist or mood). airbnb/booking_com — city (required), check_in + check_out together, guests. " +
      "Dates are YYYY-MM-DD in the user's local calendar; times are 24-hour HH:MM. If it returns an error, ask the user for what's missing rather than guessing. Put the returned url on its own line in your reply.",
    input_schema: {
      type: "object",
      properties: {
        app: { type: "string", enum: [...APP_NAMES] },
        origin: {
          type: "object",
          description: "Start point. Omit for the user's current location.",
          properties: {
            name: { type: "string" },
            address: { type: "string" },
            latitude: { type: "number" },
            longitude: { type: "number" },
          },
        },
        destination: {
          type: "object",
          description: "Where they're going: a name, an address, and/or coordinates.",
          properties: {
            name: { type: "string" },
            address: { type: "string" },
            latitude: { type: "number" },
            longitude: { type: "number" },
          },
        },
        travel_mode: { type: "string", enum: ["drive", "walk", "transit", "bike"], description: "google_maps only." },
        query: { type: "string", description: "opentable: restaurant + area. resy: restaurant name. spotify: what to search for." },
        city: { type: "string", description: "resy, airbnb, booking_com: the city or area to search." },
        party_size: { type: "number", description: "opentable/resy: number of diners, 1–20." },
        date: { type: "string", description: "opentable/resy: YYYY-MM-DD." },
        time: { type: "string", description: "opentable: HH:MM, 24-hour." },
        check_in: { type: "string", description: "airbnb/booking_com: YYYY-MM-DD." },
        check_out: { type: "string", description: "airbnb/booking_com: YYYY-MM-DD, after check_in." },
        guests: { type: "number", description: "airbnb/booking_com: number of adults, 1–20." },
      },
      required: ["app"],
    },
  },
```

`runTool` case, inserted directly after the `flag_unmet_request` case's `return { ok: true };`:

```ts
    case "make_app_link":
      return makeAppLink(input, { today: userLocalClock(ownerId).dateKey });
```

System-prompt rule. Add this string to the `base` array in `buildRules`, directly after the `ask_user_choice` rule (the second entry):

```ts
    "- For a ride, directions, a restaurant table, music or a place to stay, use make_app_link to give the user a link that opens the app already filled in — never hand-write Uber/Lyft/OpenTable/Resy/Spotify/Airbnb/Booking.com links. Never say or claim you've booked, ordered or started playing anything: say it's ready for them to confirm in the app. If they want you to complete the booking or payment yourself, explain that you set it up and they confirm in the app, and call flag_unmet_request in the same turn.",
```

- [ ] **Step 4: Run the tests to verify they pass, then run the full suite**

Run: `cd server && npx vitest run src/ai/assistant.test.ts -t make_app_link`
Expected: all 5 PASS.

Run: `cd server && npm test`
Expected: all PASS. If `assistant.cacheBreakpoint.test.ts` or a tool-count snapshot fails, check it's only about the new tool. Update an expected count by +1, but never move the cache breakpoint logic.

- [ ] **Step 5: Typecheck and commit**

```bash
cd server && npx tsc -p tsconfig.json --noEmit
git add server/src/ai/assistant.ts server/src/ai/assistant.test.ts
git commit -m "feat: make_app_link tool — hand-off links to Uber, OpenTable, Spotify and more"
```

---

### Task 4: Real-device check and docs

**Files:**
- Possibly modify: `server/src/services/appLinks.ts` and its test (only to drop or fix a format that fails on a device)
- Create: `changelog/2026-10-12-app-handoff-links.md`
- Modify: `README.md` (capabilities list)

- [ ] **Step 1: Generate one sample link per app.** Run from `server/`:

```bash
npx tsx -e "import('./src/services/appLinks.ts').then(({ makeAppLink }) => { const ctx = { today: new Date().toISOString().slice(0, 10) }; const d = new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10); const d2 = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10); for (const r of [ { app: 'uber', destination: { name: 'Heathrow Terminal 5', address: 'Wallis Rd, Hounslow TW6 2GA', latitude: 51.4723, longitude: -0.4880 } }, { app: 'lyft', destination: { latitude: 40.6413, longitude: -73.7781 } }, { app: 'google_maps', destination: { name: 'Borough Market, London' }, travel_mode: 'walk' }, { app: 'opentable', query: 'Dishoom Shoreditch London', party_size: 4, date: d, time: '20:00' }, { app: 'resy', city: 'New York, NY', query: 'Carbone', party_size: 2, date: d }, { app: 'spotify', query: 'lofi beats' }, { app: 'airbnb', city: 'Lisbon, Portugal', check_in: d, check_out: d2, guests: 2 }, { app: 'booking_com', city: 'Lisbon', check_in: d, check_out: d2, guests: 2 } ]) console.log(r.app, JSON.stringify(makeAppLink(r, ctx))); })"
```

- [ ] **Step 2: Manual check (needs a person with an iPhone and an Android phone).** Send each URL to yourself on WhatsApp and tap it, once with the app installed and once without. For each app, record: opens the app? / fields pre-filled? / falls back to a working web page?
  - If a format opens but doesn't fill in, look up the app's current deep-link documentation, fix that builder and its exact-URL test, and re-run `npx vitest run src/services/appLinks.test.ts`.
  - If it can't be made to work (Resy is the most likely), remove that app from `APP_NAMES`, `BUILDERS`, its tests, the tool description and the prompt rule's app list. Note it in the changelog.

- [ ] **Step 3: Write the changelog** `changelog/2026-10-12-app-handoff-links.md`:

```markdown
Marlowe can now send links that open Uber, Lyft, Google Maps, OpenTable, Resy, Spotify, Airbnb and Booking.com already filled in.

**What changed:** a new `make_app_link` tool (`server/src/services/appLinks.ts`). Ask Marlowe for a
ride, a table, directions, music or a stay, and it replies with a link that opens that app with the
details pre-filled (drop-off, party size and time, dates and guests…). You confirm in the app.

**Why:** these apps don't offer public APIs for acting on a user's behalf (Spotify limits its API
to companies with 250k+ monthly users; Uber, OpenTable and Resy are partner-only), so MCP/OAuth
connections aren't possible. Deep links need no keys and no user setup, and add only one tool. When a
user asks Marlowe to complete a booking itself, that's recorded in the Portal's Unmet Requests tab,
which tells us whether to build browser automation next.

**Device check:** <fill in the per-app results from Task 4 Step 2, and any app that was dropped>.

Design: `docs/superpowers/specs/2026-10-12-app-handoff-links-design.md`.
```

Replace the `<fill in…>` line with the actual results from Step 2. Don't commit it with the placeholder still in.

- [ ] **Step 4: Update the README.** Find the capabilities/features list in `README.md` (search for where web search or Google Maps abilities are described) and add one bullet in the same style:

```markdown
- **App hand-off links:** Marlowe sends links that open Uber, Lyft, Google Maps, OpenTable, Resy, Spotify, Airbnb or Booking.com already filled in; you confirm in the app. There's no setup and no API keys.
```

(Drop any app removed in Step 2.)

- [ ] **Step 5: Run the full suite and commit**

```bash
cd server && npm test && npx tsc -p tsconfig.json --noEmit
git add README.md changelog/2026-10-12-app-handoff-links.md server/src/services/appLinks.ts server/src/services/appLinks.test.ts server/src/ai/assistant.ts
git commit -m "docs: changelog and README for app hand-off links"
```
