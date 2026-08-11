import { Router } from "express";
import { runAssistantChat, type ChatMessage } from "../ai/assistant.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const assistantRoutes = Router();

assistantRoutes.post("/api/assistant/chat", async (req, res) => {
  const history = req.body?.messages as ChatMessage[] | undefined;
  if (!Array.isArray(history) || history.length === 0) {
    res.status(400).json({ error: "messages array is required" });
    return;
  }
  try {
    const reply = await runAssistantChat((req as unknown as AuthedRequest).userId, history);
    res.json({ reply });
  } catch (err) {
    console.error("assistant chat failed", err);
    res.status(500).json({ error: (err as Error).message });
  }
});
