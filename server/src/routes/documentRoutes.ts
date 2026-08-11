import { Router } from "express";
import fs from "node:fs";
import { listDocuments, searchDocuments, getDocument, deleteDocument } from "../db/store.js";
import { decryptBuffer } from "../services/crypto.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const documentRoutes = Router();

documentRoutes.get("/api/documents", (req, res) => {
  const ownerId = (req as unknown as AuthedRequest).userId;
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  res.json(q ? searchDocuments(ownerId, q, 50) : listDocuments(ownerId, 200));
});

documentRoutes.get("/api/documents/:id/file", (req, res) => {
  const doc = getDocument((req as unknown as AuthedRequest).userId, Number(req.params.id));
  if (!doc || !fs.existsSync(doc.storedPath)) {
    res.sendStatus(404);
    return;
  }
  const onDisk = fs.readFileSync(doc.storedPath);
  // Files saved before encryption was added are still plaintext on disk — same lazy-fallback
  // approach as tokens in store.ts. They'd need re-uploading to actually become encrypted.
  let plaintext: Buffer;
  try {
    plaintext = decryptBuffer(onDisk);
  } catch {
    plaintext = onDisk;
  }
  res.setHeader("Content-Type", doc.mimeType);
  res.send(plaintext);
});

documentRoutes.delete("/api/documents/:id", (req, res) => {
  const ownerId = (req as unknown as AuthedRequest).userId;
  const id = Number(req.params.id);
  const doc = getDocument(ownerId, id);
  if (doc && fs.existsSync(doc.storedPath)) {
    fs.unlinkSync(doc.storedPath);
  }
  deleteDocument(ownerId, id);
  res.json({ ok: true });
});
