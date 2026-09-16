import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../ai/assistant.js", () => ({
  getHelpChatReply: vi.fn(async () => "Marlowe reads your mail and calendar, and answers on WhatsApp."),
}));

const { helpChatRoutes, MAX_HELP_CHAT_MESSAGE_CHARS, helpChatRateLimitTrackedVisitors } = await import(
  "./helpChatRoutes.js"
);
const { configureTrustProxy } = await import("../config.js");
const { getHelpChatReply } = await import("../ai/assistant.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(helpChatRoutes);
  return app;
}

// How index.ts configures the real app in production — requests carry X-Forwarded-For from the proxy.
function buildProxiedApp() {
  const app = express();
  configureTrustProxy(app, { NODE_ENV: "production" });
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

  // Behind Railway's proxy every request arrives from the proxy's address; without trust proxy
  // configured, req.ip was that address and every visitor shared one bucket.
  it("gives each visitor behind the production proxy their own rate-limit bucket", async () => {
    const app = buildProxiedApp();

    for (let i = 0; i < 16; i++) {
      await request(app).post("/api/help-chat").set("X-Forwarded-For", "203.0.113.10").send({ message: `a ${i}` });
    }
    const other = await request(app)
      .post("/api/help-chat")
      .set("X-Forwarded-For", "203.0.113.20")
      .send({ message: "hello" });

    expect(other.status).toBe(200);
  });

  it("does not let a client pick its own bucket by prepending a fake X-Forwarded-For entry", async () => {
    const app = buildProxiedApp();

    let lastStatus = 200;
    for (let i = 0; i < 16; i++) {
      const res = await request(app)
        .post("/api/help-chat")
        .set("X-Forwarded-For", `10.9.${i}.1, 203.0.113.30`)
        .send({ message: `spoof ${i}` });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  it("rejects an over-long message without calling the model", async () => {
    const app = buildProxiedApp();
    const res = await request(app)
      .post("/api/help-chat")
      .set("X-Forwarded-For", "203.0.113.50")
      .send({ message: "x".repeat(MAX_HELP_CHAT_MESSAGE_CHARS + 1) });
    expect(res.status).toBe(400);
    expect(getHelpChatReply).not.toHaveBeenCalled();
  });

  it("truncates over-long history turns before they reach the model", async () => {
    const app = buildProxiedApp();
    await request(app)
      .post("/api/help-chat")
      .set("X-Forwarded-For", "203.0.113.40")
      .send({ message: "hi", history: [{ role: "assistant", text: "y".repeat(50_000) }] });
    const passedHistory = vi.mocked(getHelpChatReply).mock.calls[0][0];
    expect(passedHistory[0].text.length).toBeLessThanOrEqual(MAX_HELP_CHAT_MESSAGE_CHARS * 2);
  });

  it("forgets visitors whose window has expired, so the tracking map doesn't grow forever", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const app = buildProxiedApp();
      for (let i = 0; i < 5; i++) {
        await request(app).post("/api/help-chat").set("X-Forwarded-For", `198.51.100.${i}`).send({ message: "hi" });
      }
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      await request(app).post("/api/help-chat").set("X-Forwarded-For", "198.51.100.99").send({ message: "hi" });

      expect(helpChatRateLimitTrackedVisitors()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
