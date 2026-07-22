import { Router } from "express";
import { hubListMessages, hubGetMessage, hubListEvents, hubSearchFiles } from "../services/hub.js";

export const dataRoutes = Router();

dataRoutes.get("/api/messages", async (req, res) => {
  try {
    const query = typeof req.query.q === "string" ? req.query.q : undefined;
    res.json(await hubListMessages({ query }));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

dataRoutes.get("/api/messages/:accountId/:messageId", async (req, res) => {
  try {
    const message = await hubGetMessage(Number(req.params.accountId), req.params.messageId);
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
    res.json(await hubListEvents(days));
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
    res.json(await hubSearchFiles(query));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
