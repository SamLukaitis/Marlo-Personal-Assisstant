import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findOrCreateUserByEmail, addLocalRoot } from "../db/store.js";
import { addLocalFolder, listLocalFolders, localSearchFiles } from "./local.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

function tempDirWithFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-folders-"));
  fs.writeFileSync(path.join(dir, name), "x");
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// "Folders on this computer" means the machine the server runs on. On a hosted deployment that's
// the server itself, so any invited user could add "/" and list server file names by searching.
describe("local folders on a hosted (production) server", () => {
  it("refuses to add a folder", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const user = findOrCreateUserByEmail(uniqueEmail("local-prod-add"));

    await expect(addLocalFolder(user.id, os.tmpdir())).rejects.toThrow(/only available/i);
    expect(listLocalFolders(user.id)).toEqual([]);
  });

  it("ignores folders saved before the restriction, for listing and search", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const user = findOrCreateUserByEmail(uniqueEmail("local-prod-existing"));
    const dir = tempDirWithFile("secret-config.txt");
    addLocalRoot(user.id, dir, "tmp");

    expect(listLocalFolders(user.id)).toEqual([]);
    expect(await localSearchFiles(user.id, "secret")).toEqual([]);
  });

  it("can be explicitly enabled for a self-hosted production install", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOCAL_FOLDERS_ENABLED", "true");
    const user = findOrCreateUserByEmail(uniqueEmail("local-prod-optin"));
    const dir = tempDirWithFile("notes.txt");

    await addLocalFolder(user.id, dir);

    expect((await localSearchFiles(user.id, "notes")).map((h) => h.name)).toEqual(["notes.txt"]);
  });
});

describe("local folders in development", () => {
  it("adds a folder and finds files in it by name", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const user = findOrCreateUserByEmail(uniqueEmail("local-dev"));
    const dir = tempDirWithFile("invoice-march.pdf");

    await addLocalFolder(user.id, dir);

    expect((await localSearchFiles(user.id, "invoice")).map((h) => h.name)).toEqual(["invoice-march.pdf"]);
  });
});
