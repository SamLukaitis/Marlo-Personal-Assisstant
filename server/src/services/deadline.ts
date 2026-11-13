// Bounds how long a caller waits on a promise. Used where one stuck network call must not hold up
// everything queued behind it (the scheduler's per-user steps): on 13 Nov 2026 a provider call that
// never returned froze the whole scheduler for 15 hours.
//
// The underlying work is NOT cancelled, only abandoned: it may still finish later. Callers must be
// safe against that (the scheduler's sends are deduplicated by proactiveDelivery.ts's ledger).
export class DeadlineError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${Math.round(ms / 1000)}s`);
    this.name = "DeadlineError";
  }
}

export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
