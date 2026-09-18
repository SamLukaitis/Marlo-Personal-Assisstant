import { describe, it, expect } from "vitest";
import { isObviousContinue } from "./setupIntent.js";

describe("isObviousContinue", () => {
  it.each(["skip", "Skip.", "no thanks", "Let's just set up", "lets setup", "just set up", "carry on", "not now!"])(
    "treats %j as carrying on with setup",
    (reply) => {
      expect(isObviousContinue(reply)).toBe(true);
    }
  );

  it.each(["skip the intro and tell me what's urgent", "set up a meeting with John", "what's on my calendar?"])(
    "leaves %j for the model / assistant",
    (reply) => {
      expect(isObviousContinue(reply)).toBe(false);
    }
  );
});
