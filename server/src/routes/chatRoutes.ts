import { Router } from "express";
import { hubListChats, hubSearchChats } from "../services/hub.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const chatRoutes = Router();

chatRoutes.get("/api/chats", async (req, res) => {
  try {
    const ownerId = (req as unknown as AuthedRequest).userId;
    const query = typeof req.query.q === "string" ? req.query.q : undefined;
    res.json(query ? await hubSearchChats(ownerId, query) : await hubListChats(ownerId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
