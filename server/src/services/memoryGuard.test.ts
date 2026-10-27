import { describe, it, expect } from "vitest";
import { rejectFactReason } from "./memoryGuard.js";

describe("rejectFactReason", () => {
  it.each([
    "TikTok sent a verification code (992981, valid for 48 hours) to Sam's account @sklg_.",
    "Sam's OTP for the bank is 482193.",
    "Sam's card PIN is 1234.",
    "Sam's location on October 20, 2026 at 01:27 UTC was -16.400562286377, -71.540512084961.",
  ])("rejects %s", (content) => {
    expect(rejectFactReason(content)).not.toBeNull();
  });

  it.each([
    "The user's name is Sam.",
    "Sam lives in Edinburgh.",
    "Sam's flat number is 2041.",
    "Sam prefers a security-conscious approach to new apps.",
    "Sam's Wild Rover confirmation number is 23452-580678650.",
    "Sam was born in 2003.",
  ])("allows %s", (content) => {
    expect(rejectFactReason(content)).toBeNull();
  });
});
