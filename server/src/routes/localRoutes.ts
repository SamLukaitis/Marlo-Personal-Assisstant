import { Router } from "express";
import { listLocalFolders, addLocalFolder, removeLocalFolder } from "../providers/local.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const localRoutes = Router();

localRoutes.get("/api/local-folders", (req, res) => {
  res.json(listLocalFolders((req as unknown as AuthedRequest).userId));
});

localRoutes.post("/api/local-folders", async (req, res) => {
  const folderPath = req.body?.path as string | undefined;
  if (!folderPath || typeof folderPath !== "string") {
    res.status(400).json({ error: "path is required" });
    return;
  }
  try {
    res.json(await addLocalFolder((req as unknown as AuthedRequest).userId, folderPath));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

localRoutes.delete("/api/local-folders/:id", (req, res) => {
  removeLocalFolder((req as unknown as AuthedRequest).userId, Number(req.params.id));
  res.json({ ok: true });
});
