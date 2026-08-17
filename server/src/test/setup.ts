import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// store.ts computes its data directory at module-load time from DATA_DIR (falling back to
// process.cwd()/data when unset — see store.ts). Setting this here, in a setupFiles script that
// vitest runs before any test file is imported, ensures every test run gets a fresh temp SQLite
// file instead of touching server/data/app.db (the real dev database).
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-test-"));
process.env.DATA_DIR = testDataDir;
