import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../ai/assistant.js", () => ({
  getHelpChatReply: vi.fn(async () => "Marlowe reads your mail and calendar, and answers on WhatsApp."),
}));

const { helpChatRoutes } = await import("./helpChatRoutes.js");
const { getHelpChatReply } = await import("../ai/assistant.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(helpChatRoutes);
  return app;
}

beforeEach(() => {
  vi.mocked(getHelpChatReply).mockClear();
});

describe("POST /api/help-chat", () => {
  it("returns a reply for a plain message", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/help-chat").send({ message: "What does Marlowe do?" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toContain("Marlowe");
    expect(getHelpChatReply).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty message", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/help-chat").send({ message: "   " });
    expect(res.status).toBe(400);
  });

  it("caps history to the last 10 turns before appending the new message", async () => {
    const app = buildApp();
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `turn ${i}`,
    }));
    await request(app).post("/api/help-chat").send({ message: "latest", history });
    const passedHistory = vi.mocked(getHelpChatReply).mock.calls[0][0];
    expect(passedHistory.length).toBe(11); // last 10 + the new message
    expect(passedHistory[passedHistory.length - 1]).toEqual({ role: "user", text: "latest" });
  });

  it("rate-limits after the per-IP threshold", async () => {
    const app = buildApp();
    let lastStatus = 200;
    for (let i = 0; i < 16; i++) {
      const res = await request(app).post("/api/help-chat").send({ message: `msg ${i}` });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
