// Whether a number is in the shape WhatsApp can actually deliver to, checked at every point a
// human types one in.
//
// WhatsApp delivers an inbound message's `from` in E.164 digits — country code, no +, never a
// leading 0. normalizePhone (db/store.ts) only strips non-digits, so a number typed in national
// format survives as "07597959648" and can never equal the "447597959648" that arrives. Nothing
// downstream compares them loosely, so the row is simply dead: an invite in that form tells a real
// tester they aren't invited, and a Settings binding in that form lets their WhatsApp message fall
// through to registration and mint a second, phone-only account beside the one they just bound it
// to. Both have happened.
//
// Deliberately does NOT try to repair the number by swapping the leading 0 for a country code:
// which country code is not knowable from the digits (this instance already has users on 44 and
// 57), and guessing wrong binds someone else's number. Reject and say what to type instead.
export function internationalPhoneError(digits: string): string | null {
  if (digits.startsWith("0")) {
    return (
      "Use the full international number with its country code and no leading 0 — " +
      "e.g. 447911123456, not 07911123456."
    );
  }
  // normalizePhone strips non-digits, so "abc1" arrives here as "1" — hence a length check rather
  // than trusting the input to have been a phone number at all. 15 is E.164's maximum.
  if (digits.length < 8 || digits.length > 15) return "that doesn't look like a valid phone number";
  return null;
}
