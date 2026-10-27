// A last check on every fact before it's stored, from either the assistant's remember tool or
// background extraction. The prompts already say "durable facts only, never secrets", but models
// don't follow that reliably — this catches the two kinds of junk that are both common and
// unambiguous: one-time codes and raw GPS coordinates. Everything else (one-off events, stale
// plans) is left to the prompts, since a regex can't tell those from real facts.

// A code word near a 4–8 digit number: "verification code 992981", "OTP: 4821", "PIN 1234".
const CODE_WORD = /\b(verification|one[- ]time|login|security|auth(?:entication)?|2fa)\s+(code|passcode|pin)\b|\b(otp|passcode|pin)\b/i;
const CODE_DIGITS = /\b\d{4,8}\b/;
// A latitude, longitude pair with GPS-level precision: "-16.400562, -71.540512".
const COORDINATES = /-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/;

// Why this fact shouldn't be stored, or null when it's fine.
export function rejectFactReason(content: string): string | null {
  if (CODE_WORD.test(content) && CODE_DIGITS.test(content)) {
    return "it contains a one-time code or PIN, which must never be stored";
  }
  if (COORDINATES.test(content)) {
    return "it records a precise location, which is only true at that moment";
  }
  return null;
}
