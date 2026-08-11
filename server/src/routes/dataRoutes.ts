import { Router } from "express";
import {
  hubListMessages,
  hubGetMessage,
  hubListEvents,
  hubSearchFiles,
  hubCreateEvent,
  hubUpdateEvent,
  hubDeleteEvent,
  hubArchiveMessages,
  hubAddLabel,
  hubSearchContacts,
} from "../services/hub.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const dataRoutes = Router();

dataRoutes.get("/api/messages", async (req, res) => {
  try {
    const query = typeof req.query.q === "string" ? req.query.q : undefined;
    res.json(await hubListMessages((req as unknown as AuthedRequest).userId, { query }));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

dataRoutes.get("/api/messages/:accountId/:messageId", async (req, res) => {
  try {
    const message = await hubGetMessage(
      (req as unknown as AuthedRequest).userId,
      Number(req.params.accountId),
      req.params.messageId
    );
    if (!message) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(message);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

dataRoutes.get("/api/events", async (req, res) => {
  try {
    const days = Number(req.query.days) || 7;
    res.json(await hubListEvents((req as unknown as AuthedRequest).userId, days));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

dataRoutes.get("/api/files", async (req, res) => {
  try {
    const query = typeof req.query.q === "string" ? req.query.q : "";
    if (!query) {
      res.json([]);
      return;
    }
    res.json(await hubSearchFiles((req as unknown as AuthedRequest).userId, query));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

dataRoutes.post("/api/events", async (req, res) => {
  try {
    const { accountId, title, start, end, location, description } = req.body ?? {};
    res.json(
      await hubCreateEvent((req as unknown as AuthedRequest).userId, Number(accountId), {
        title,
        start,
        end,
        location,
        description,
      })
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

dataRoutes.patch("/api/events/:accountId/:eventId", async (req, res) => {
  try {
    res.json(
      await hubUpdateEvent(
        (req as unknown as AuthedRequest).userId,
        Number(req.params.accountId),
        req.params.eventId,
        req.body ?? {}
      )
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

dataRoutes.delete("/api/events/:accountId/:eventId", async (req, res) => {
  try {
    await hubDeleteEvent((req as unknown as AuthedRequest).userId, Number(req.params.accountId), req.params.eventId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

dataRoutes.post("/api/messages/:accountId/archive", async (req, res) => {
  try {
    const query = (req.body?.query as string) ?? "";
    const archived = await hubArchiveMessages(
      (req as unknown as AuthedRequest).userId,
      Number(req.params.accountId),
      query
    );
    res.json({ archived });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

dataRoutes.post("/api/messages/:accountId/:messageId/label", async (req, res) => {
  try {
    const label = (req.body?.label as string) ?? "";
    await hubAddLabel((req as unknown as AuthedRequest).userId, Number(req.params.accountId), req.params.messageId, label);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

dataRoutes.get("/api/contacts", async (req, res) => {
  try {
    const query = typeof req.query.q === "string" ? req.query.q : "";
    if (!query) {
      res.json([]);
      return;
    }
    res.json(await hubSearchContacts((req as unknown as AuthedRequest).userId, query));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
