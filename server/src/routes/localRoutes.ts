import { Router } from "express";
import { listLocalFolders, addLocalFolder, removeLocalFolder } from "../providers/local.js";

export const localRoutes = Router();

localRoutes.get("/api/local-folders", (_req, res) => {
  res.json(listLocalFolders());
});

localRoutes.post("/api/local-folders", async (req, res) => {
  const folderPath = req.body?.path as string | undefined;
  if (!folderPath || typeof folderPath !== "string") {
    res.status(400).json({ error: "path is required" });
    return;
  }
  try {
    res.json(await addLocalFolder(folderPath));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

localRoutes.delete("/api/local-folders/:id", (req, res) => {
  removeLocalFolder(Number(req.params.id));
  res.json({ ok: true });
});
