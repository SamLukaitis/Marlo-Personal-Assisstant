import { Router } from "express";
import fs from "node:fs";
import { listDocuments, searchDocuments, getDocument, deleteDocument } from "../db/store.js";

export const documentRoutes = Router();

documentRoutes.get("/api/documents", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  res.json(q ? searchDocuments(q, 50) : listDocuments(200));
});

documentRoutes.get("/api/documents/:id/file", (req, res) => {
  const doc = getDocument(Number(req.params.id));
  if (!doc || !fs.existsSync(doc.storedPath)) {
    res.sendStatus(404);
    return;
  }
  res.setHeader("Content-Type", doc.mimeType);
  res.sendFile(doc.storedPath);
});

documentRoutes.delete("/api/documents/:id", (req, res) => {
  const id = Number(req.params.id);
  const doc = getDocument(id);
  if (doc && fs.existsSync(doc.storedPath)) {
    fs.unlinkSync(doc.storedPath);
  }
  deleteDocument(id);
  res.json({ ok: true });
});
