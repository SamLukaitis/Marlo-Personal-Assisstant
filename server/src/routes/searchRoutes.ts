import { Router } from "express";
import { hubListMessages, hubSearchFiles, hubSearchChats } from "../services/hub.js";
import { searchDocuments } from "../db/store.js";

export const searchRoutes = Router();

searchRoutes.get("/api/search", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    res.status(400).json({ error: "q is required" });
    return;
  }

  const [messages, files, chats, documents] = await Promise.all([
    hubListMessages({ query: q, limit: 15 }).catch(() => []),
    hubSearchFiles(q).catch(() => []),
    hubSearchChats(q).catch(() => []),
    Promise.resolve(searchDocuments(q, 15)),
  ]);

  res.json({ messages, files, chats, documents });
});
