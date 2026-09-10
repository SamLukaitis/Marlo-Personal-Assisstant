// Small dependency-free concurrency limiter. Pulled out of google.ts, where firing every
// messages.get call at once via a bare Promise.all was the actual cause of a production incident
// (2026-09-10): Gmail charges 5 quota units per messages.get, and a single hubListMessages call
// with limit 150 (reconciliation.ts's scan) fired 150 of those simultaneously — a 750-unit spike
// in a single instant, which is exactly the kind of burst a "units per minute" quota is built to
// reject. Capping how many run at once spreads the same total cost over time instead of firing it
// all in one instant, without changing what gets fetched.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
