import { Router } from "express";
import { listMemoryNotes, addMemoryNote, removeMemoryNote } from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const memoryRoutes = Router();

memoryRoutes.get("/api/memory", (req, res) => {
  res.json(listMemoryNotes((req as unknown as AuthedRequest).userId));
});

memoryRoutes.post("/api/memory", (req, res) => {
  const content = req.body?.content as string | undefined;
  if (!content || !content.trim()) {
    res.status(400).json({ error: "content is required" });
    return;
  }
  res.json(addMemoryNote((req as unknown as AuthedRequest).userId, content.trim()));
});

memoryRoutes.delete("/api/memory/:id", (req, res) => {
  removeMemoryNote((req as unknown as AuthedRequest).userId, Number(req.params.id));
  res.json({ ok: true });
});
