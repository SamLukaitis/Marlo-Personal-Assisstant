import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// store.ts computes its data directory at module-load time from DATA_DIR (falling back to
// process.cwd()/data when unset — see store.ts). Setting this here, in a setupFiles script that
// vitest runs before any test file is imported, ensures every test run gets a fresh temp SQLite
// file instead of touching server/data/app.db (the real dev database).
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-test-"));
process.env.DATA_DIR = testDataDir;

// crypto.ts (encrypting OAuth tokens/documents at rest) reads this lazily per call and throws if
// it's unset — fine for the app itself (a real deployment must set a real key), but any test that
// exercises a code path touching account tokens or documents needs *a* key present. Fixed value,
// not a generated one: test data is thrown away with testDataDir above, so nothing depends on
// this being secret or stable across runs — it only needs to be present and 64 hex chars.
process.env.ENCRYPTION_KEY = "0".repeat(64);
