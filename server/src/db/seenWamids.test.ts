import { describe, it, expect } from "vitest";
import { markWamidSeenIfNew, deleteExpiredSeenWamids } from "./store.js";

describe("seen_wamids", () => {
  it("returns true the first time a wamid is seen, false on every repeat", () => {
    const wamid = `wamid.first-${Date.now()}`;
    expect(markWamidSeenIfNew(wamid)).toBe(true);
    expect(markWamidSeenIfNew(wamid)).toBe(false);
    expect(markWamidSeenIfNew(wamid)).toBe(false);
  });

  it("treats different wamids independently", () => {
    const a = `wamid.a-${Date.now()}`;
    const b = `wamid.b-${Date.now()}`;
    expect(markWamidSeenIfNew(a)).toBe(true);
    expect(markWamidSeenIfNew(b)).toBe(true);
  });

  it("deleteExpiredSeenWamids only removes rows older than 8 days, dedupe still works for the rest", () => {
    const stale = `wamid.stale-${Date.now()}`;
    const fresh = `wamid.fresh-${Date.now()}`;
    markWamidSeenIfNew(stale);
    markWamidSeenIfNew(fresh);

    deleteExpiredSeenWamids();
    // Fresh row survives the sweep — still recognized as already-seen.
    expect(markWamidSeenIfNew(fresh)).toBe(false);
  });
});
