// Trivially thin, but lives in its own module so callers (whatsappReply.ts's chunk pacing) can
// vi.mock it out in tests instead of using real timers.
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
