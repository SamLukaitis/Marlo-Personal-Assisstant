import { Router } from "express";
import { listMemoryNotes, addMemoryNote, removeMemoryNote } from "../db/store.js";

export const memoryRoutes = Router();

memoryRoutes.get("/api/memory", (_req, res) => {
  res.json(listMemoryNotes());
});

memoryRoutes.post("/api/memory", (req, res) => {
  const content = req.body?.content as string | undefined;
  if (!content || !content.trim()) {
    res.status(400).json({ error: "content is required" });
    return;
  }
  res.json(addMemoryNote(content.trim()));
});

memoryRoutes.delete("/api/memory/:id", (req, res) => {
  removeMemoryNote(Number(req.params.id));
  res.json({ ok: true });
});
