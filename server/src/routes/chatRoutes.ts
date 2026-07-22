import { Router } from "express";
import { hubListChats, hubSearchChats } from "../services/hub.js";

export const chatRoutes = Router();

chatRoutes.get("/api/chats", async (req, res) => {
  try {
    const query = typeof req.query.q === "string" ? req.query.q : undefined;
    res.json(query ? await hubSearchChats(query) : await hubListChats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
