import { Router } from "express";
import { getHelpChatReply, type HelpChatTurn } from "../ai/assistant.js";

export const helpChatRoutes = Router();

// Public, unauthenticated endpoint (the marketing homepage's help widget, reachable by anyone
// who hasn't signed in yet) that spends a real LLM call per message — worth a basic per-IP
// throttle even though this isn't the security boundary for anything, just cost control. Same
// lightweight in-memory-map style as whatsappRegistration.ts's lastTokenIssuedAt; a restart
// clears it, which is fine for an abuse-cost guard rather than a hard limit.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_PER_WINDOW = 15;
const requestTimestamps = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (requestTimestamps.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  requestTimestamps.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX_PER_WINDOW;
}

const MAX_HISTORY_TURNS = 10;

function isValidTurn(t: unknown): t is HelpChatTurn {
  return (
    typeof t === "object" &&
    t !== null &&
    ((t as HelpChatTurn).role === "user" || (t as HelpChatTurn).role === "assistant") &&
    typeof (t as HelpChatTurn).text === "string"
  );
}

helpChatRoutes.post("/api/help-chat", async (req, res) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  if (isRateLimited(ip)) {
    res.status(429).json({ error: "Too many messages — wait a bit before trying again." });
    return;
  }

  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
  const history: HelpChatTurn[] = rawHistory.filter(isValidTurn).slice(-MAX_HISTORY_TURNS);
  history.push({ role: "user", text: message });

  try {
    const reply = await getHelpChatReply(history);
    res.json({ reply });
  } catch (err) {
    // getHelpChatReply already falls back internally on its own errors — this catch is just the
    // backstop for anything unexpected (e.g. a thrown validation error) so the route never hangs.
    console.error("help-chat: unexpected failure", err);
    res.status(500).json({ error: "failed to get a reply" });
  }
});
