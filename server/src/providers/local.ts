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

// "This computer" is whatever machine the server runs on. That is the user's own PC for a local
// install, but on a hosted deployment (Railway) it is the server itself, where letting any invited
// user add a folder would let them list the server's file names (directly, or through the
// assistant's search_files). Off in production unless a self-hosted install opts in; checked on
// every call, so folders saved before this restriction are ignored too.
export function localFoldersEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.LOCAL_FOLDERS_ENABLED === "true";
}

export function listLocalFolders(ownerId: number): LocalRootRow[] {
  if (!localFoldersEnabled()) return [];
  return listLocalRoots(ownerId);
}

export async function addLocalFolder(ownerId: number, rootPath: string): Promise<LocalRootRow> {
  if (!localFoldersEnabled()) {
    throw new Error("Folders on this computer are only available when Marlo runs on your own computer.");
  }
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
  const roots = listLocalFolders(ownerId);
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
