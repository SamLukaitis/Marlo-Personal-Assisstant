import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import {
  listLocalRoots,
  addLocalRoot as dbAddLocalRoot,
  removeLocalRoot as dbRemoveLocalRoot,
  type LocalRootRow,
} from "../db/store.js";
import type { FileHit } from "./types.js";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "$RECYCLE.BIN",
  "System Volume Information",
  ".cache",
  "AppData",
]);
const MAX_FILES_SCANNED = 20000;
const MAX_DEPTH = 12;

export function listLocalFolders(ownerId: number): LocalRootRow[] {
  return listLocalRoots(ownerId);
}

export async function addLocalFolder(ownerId: number, rootPath: string): Promise<LocalRootRow> {
  const resolved = path.resolve(rootPath);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`${resolved} is not a directory`);
  }
  return dbAddLocalRoot(ownerId, resolved, path.basename(resolved));
}

export function removeLocalFolder(ownerId: number, id: number): void {
  dbRemoveLocalRoot(ownerId, id);
}

export async function localSearchFiles(ownerId: number, query: string, limit = 15): Promise<FileHit[]> {
  const roots = listLocalRoots(ownerId);
  const trimmed = query.trim().toLowerCase();
  if (!roots.length || !trimmed) return [];

  const hits: FileHit[] = [];
  let scanned = 0;

  async function walkDir(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || scanned > MAX_FILES_SCANNED) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (scanned > MAX_FILES_SCANNED) return;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walkDir(full, depth + 1);
      } else if (entry.isFile()) {
        scanned++;
        if (entry.name.toLowerCase().includes(trimmed)) {
          try {
            const stat = await fs.stat(full);
            hits.push({
              id: full,
              accountId: 0,
              accountEmail: "This computer",
              provider: "local",
              name: entry.name,
              mimeType: path.extname(entry.name).replace(/^\./, "") || "file",
              modifiedAt: stat.mtime.toISOString(),
              link: undefined,
            });
          } catch {
            // unreadable file — skip
          }
        }
      }
    }
  }

  for (const root of roots) {
    await walkDir(root.path, 0);
  }

  return hits.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1)).slice(0, limit);
}
