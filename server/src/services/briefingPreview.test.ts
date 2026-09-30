import { describe, it, expect } from "vitest";
import { buildProfiles, DEFAULT_SEED, newSeed } from "./briefingPreview.js";
import { isQuietDay } from "./briefing.js";

// The lab's value depends on two properties: a seed always gives the same ten days (so a set that
// broke the prompt can be reproduced from its number) and a different seed genuinely re-rolls them
// (so Scramble shows variety rather than the same days with the numbers nudged).
describe("buildProfiles", () => {
  it("gives ten profiles with unique ids", () => {
    const profiles = buildProfiles(DEFAULT_SEED);
    expect(profiles).toHaveLength(10);
    expect(new Set(profiles.map((p) => p.id)).size).toBe(10);
  });

  it("is deterministic for a seed", () => {
    expect(buildProfiles(4821)).toEqual(buildProfiles(4821));
  });

  // Scramble has to re-roll each card independently, not shift the whole set along by one. The
  // profiles with content to vary must always change; "newuser" is deliberately exempt, since a
  // brand-new signup with no name, no feeds and an empty day has only its weekday to vary and can
  // legitimately land on the same one twice.
  it("re-rolls each profile's day independently on a new seed", () => {
    for (const [x, y] of [[1, 2], [2, 3], [7, 512]]) {
      const a = buildProfiles(x);
      const b = buildProfiles(y);
      const unchanged = a
        .filter((p, i) => JSON.stringify(p.day) === JSON.stringify(b[i].day))
        .map((p) => p.id);
      expect(unchanged.filter((id) => id !== "newuser"), `seeds ${x}/${y}`).toEqual([]);
    }
  });

  it("keeps the shown unread list consistent with its count", () => {
    for (const seed of [1, 2, 99, 4821]) {
      for (const p of buildProfiles(seed)) {
        expect(p.day.unread.shown).toHaveLength(p.day.unread.count);
      }
    }
  });

  it("never lists the same email twice in one inbox", () => {
    for (const seed of [1, 7, 512]) {
      for (const p of buildProfiles(seed)) {
        const subjects = p.day.unread.shown.map((m) => m.subject);
        expect(new Set(subjects).size).toBe(subjects.length);
      }
    }
  });

  it("never repeats a calendar event within a day", () => {
    for (const seed of [1, 7, 512]) {
      for (const p of buildProfiles(seed)) {
        expect(new Set(p.day.todayEvents).size).toBe(p.day.todayEvents.length);
        expect(new Set(p.day.upcomingEvents).size).toBe(p.day.upcomingEvents.length);
      }
    }
  });

  // These three exist to exercise the quiet-day branch of the prompt, so they have to stay quiet
  // on every seed — a scramble that gave the retiree a full inbox would silently lose that coverage.
  it("keeps the quiet profiles quiet on every seed", () => {
    for (const seed of [1, 2, 3, 50, 4821]) {
      const byId = Object.fromEntries(buildProfiles(seed).map((p) => [p.id, p]));
      for (const id of ["retiree", "newuser", "minimalist"]) {
        expect(isQuietDay(byId[id].day), `${id} @ seed ${seed}`).toBe(true);
      }
    }
  });

  // The nomad is the interesting case: quiet today, but with a flight to pack for, which the
  // prompt has to surface anyway. Worth pinning so a pool edit can't quietly drop it.
  it("always gives the nomad a quiet day with something upcoming", () => {
    for (const seed of [1, 2, 3, 50, 4821]) {
      const nomad = buildProfiles(seed).find((p) => p.id === "nomad")!;
      expect(isQuietDay(nomad.day)).toBe(true);
      expect(nomad.day.upcomingEvents.length).toBeGreaterThan(0);
    }
  });

  it("only gives markets and news to the profiles that opted into them", () => {
    for (const seed of [1, 77]) {
      const byId = Object.fromEntries(buildProfiles(seed).map((p) => [p.id, p]));
      expect(byId.trader.day.quotes.length).toBeGreaterThan(0);
      expect(byId.trader.day.news.length).toBeGreaterThan(0);
      // A minimalist with everything off must get no opt-in feed at all, or the prompt's
      // "mention it ONLY if its fact line is present" rule isn't being tested by anything.
      expect(byId.minimalist.day.quotes).toEqual([]);
      expect(byId.minimalist.day.news).toEqual([]);
      expect(byId.minimalist.day.weather).toBeNull();
    }
  });
});

describe("newSeed", () => {
  it("stays in the range the page can round-trip through its seed box", () => {
    for (let i = 0; i < 200; i++) {
      const s = newSeed();
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThan(10000);
    }
  });
});
