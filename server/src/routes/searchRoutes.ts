import { Router } from "express";
import { hubListMessages, hubSearchFiles, hubSearchChats } from "../services/hub.js";
import { searchDocuments } from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const searchRoutes = Router();

searchRoutes.get("/api/search", async (req, res) => {
  const ownerId = (req as unknown as AuthedRequest).userId;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    res.status(400).json({ error: "q is required" });
    return;
  }

  try {
    const [messages, files, chats, documents] = await Promise.all([
      hubListMessages(ownerId, { query: q, limit: 15 }).catch(() => []),
      hubSearchFiles(ownerId, q).catch(() => []),
      hubSearchChats(ownerId, q).catch(() => []),
      // searchDocuments is synchronous (better-sqlite3) — a throw here (e.g. from a search
      // string SQLite doesn't like) previously escaped uncaught and crashed the whole process,
      // since Express 4 never awaits/catches an async route handler's own rejection.
      Promise.resolve().then(() => searchDocuments(ownerId, q, 15)),
    ]);

    res.json({ messages, files, chats, documents });
  } catch (err) {
    console.error("search: request failed", err);
    res.status(500).json({ error: "search failed" });
  }
});
