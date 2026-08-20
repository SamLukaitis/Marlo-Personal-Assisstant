import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { documentRoutes } from "./documentRoutes.js";
import { findOrCreateUserByEmail, saveDocument } from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";
import type { DocumentCategory } from "../db/store.js";

function buildTestApp(userId: number) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as AuthedRequest).userId = userId;
    next();
  });
  app.use(documentRoutes);
  return app;
}

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

function seedDoc(ownerId: number, category: DocumentCategory | null) {
  return saveDocument(ownerId, {
    phone: "447000000002",
    filename: null,
    mimeType: "image/jpeg",
    storedPath: "/tmp/fake",
    caption: null,
    title: "Seed doc",
    extractedText: "text",
    category,
  });
}

describe("GET /api/documents category filter", () => {
  it("returns only documents matching ?category=", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("route-cat"));
    seedDoc(user.id, "travel");
    seedDoc(user.id, "other");
    const app = buildTestApp(user.id);

    const res = await request(app).get("/api/documents?category=travel");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].category).toBe("travel");
  });

  it("ignores an unrecognized category value rather than erroring", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("route-cat-invalid"));
    seedDoc(user.id, "travel");
    seedDoc(user.id, "other");
    const app = buildTestApp(user.id);

    const res = await request(app).get("/api/documents?category=not-a-real-category");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it("returns everything when no category is given", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("route-cat-none"));
    seedDoc(user.id, "travel");
    seedDoc(user.id, null);
    const app = buildTestApp(user.id);

    const res = await request(app).get("/api/documents");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});
