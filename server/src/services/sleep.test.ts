import { describe, it, expect, vi } from "vitest";
import { sleep } from "./sleep.js";

describe("sleep", () => {
  it("resolves after roughly the given delay", async () => {
    vi.useFakeTimers();
    const spy = vi.fn();

    sleep(1000).then(spy);
    await vi.advanceTimersByTimeAsync(999);
    expect(spy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(spy).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
