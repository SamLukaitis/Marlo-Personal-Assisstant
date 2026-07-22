import "dotenv/config";
import express from "express";
import cors from "cors";
import { authRoutes } from "./routes/authRoutes.js";
import { accountRoutes } from "./routes/accountRoutes.js";
import { dataRoutes } from "./routes/dataRoutes.js";
import { settingsRoutes } from "./routes/settingsRoutes.js";
import { assistantRoutes } from "./routes/assistantRoutes.js";
import { localRoutes } from "./routes/localRoutes.js";
import { chatRoutes } from "./routes/chatRoutes.js";

const app = express();
const PORT = process.env.PORT ?? 4000;

app.use(cors({ origin: process.env.CLIENT_URL ?? "http://localhost:5173" }));
app.use(express.json());

app.use(authRoutes);
app.use(accountRoutes);
app.use(dataRoutes);
app.use(settingsRoutes);
app.use(assistantRoutes);
app.use(localRoutes);
app.use(chatRoutes);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
