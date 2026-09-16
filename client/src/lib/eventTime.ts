// Mirrors server/src/services/eventTime.ts. Event start/end are either a zoned ISO datetime or,
// for an all-day event, a plain "YYYY-MM-DD" — which new Date() reads as UTC midnight, i.e. the
// previous evening anywhere west of UTC. Parse through this instead.
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value);
}

export function parseEventTime(value: string): Date {
  const m = DATE_ONLY.exec(value);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
}
